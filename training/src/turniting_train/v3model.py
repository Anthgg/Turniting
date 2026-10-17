"""TURNITING_RESEARCH_V3 multi-task detector: mDeBERTa backbone + three heads.

HEAD A  binary log-odds: HUMAN vs MACHINE_SIGNAL (any AI involvement)        -> main detector
HEAD B  4 classes: HUMAN / GENERATED / EDITED / MIXED
HEAD C  per-token AI probability (trained only on rows with exact AI spans)

Saved layout (servable, no custom code beyond this module):
  <dir>/backbone/ (save_pretrained, safetensors) + tokenizer files, <dir>/heads.pt, <dir>/v3_config.json
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

from .adapters_v2 import AI_EDITED, AI_GENERATED, HUMAN, HUMAN_EDITED_AI, MIXED, PARAPHRASED_AI

FINE_CLASSES = ["HUMAN", "GENERATED", "EDITED", "MIXED"]
FINE_TO_B = {HUMAN: 0, AI_GENERATED: 1, PARAPHRASED_AI: 1, AI_EDITED: 2, HUMAN_EDITED_AI: 2, MIXED: 3}


class V3Detector(nn.Module):
    def __init__(self, backbone, hidden: int, dropout: float = 0.1):
        super().__init__()
        self.backbone = backbone
        self.dropout = nn.Dropout(dropout)
        self.pool = nn.Sequential(nn.Linear(hidden, hidden), nn.GELU())
        self.head_a = nn.Linear(hidden, 1)
        self.head_b = nn.Linear(hidden, len(FINE_CLASSES))
        self.head_c = nn.Linear(hidden, 1)

    @classmethod
    def from_base(cls, path: str):
        from transformers import AutoModel

        bb = AutoModel.from_pretrained(path)
        return cls(bb, bb.config.hidden_size)

    @classmethod
    def load(cls, path: str | Path, device="cpu"):
        from transformers import AutoModel

        path = Path(path)
        bb = AutoModel.from_pretrained(path / "backbone")
        m = cls(bb, bb.config.hidden_size)
        m.load_state_dict(torch.load(path / "heads.pt", map_location="cpu", weights_only=True), strict=False)
        return m.to(device)

    def save(self, path: str | Path, tokenizer, extra: dict | None = None):
        path = Path(path)
        path.mkdir(parents=True, exist_ok=True)
        self.backbone.save_pretrained(path / "backbone", safe_serialization=True)
        tokenizer.save_pretrained(path / "backbone")
        heads = {k: v for k, v in self.state_dict().items() if not k.startswith("backbone.")}
        torch.save(heads, path / "heads.pt")
        (path / "v3_config.json").write_text(json.dumps({"fine_classes": FINE_CLASSES, **(extra or {})}, indent=2))

    def forward(self, input_ids, attention_mask):
        hs = self.backbone(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        cls_vec = self.pool(self.dropout(hs[:, 0]))
        return {"a": self.head_a(cls_vec).squeeze(-1), "b": self.head_b(cls_vec),
                "c": self.head_c(self.dropout(hs)).squeeze(-1)}


def doc_windows(tokenizer, text: str, max_length: int, stride: int, max_windows: int | None,
                offsets: bool = False):
    """Token windows of one document: list of (ids, (tok_start, tok_end)), plus char offsets."""
    content = max_length - 2
    budget = None if max_windows is None else content + (max_windows - 1) * (content - stride)
    char_budget = None if budget is None else budget * 12
    enc = tokenizer(text[:char_budget] if char_budget else text, add_special_tokens=False, truncation=False,
                    return_offsets_mapping=offsets)
    ids = enc["input_ids"]
    offs = enc.get("offset_mapping") if offsets else None
    if budget is not None:
        ids = ids[:budget]
        offs = offs[:budget] if offs is not None else None
    if not ids:
        ids = [tokenizer.unk_token_id]
        offs = [(0, 0)] if offsets else None
    step = max(1, content - stride)
    out, start = [], 0
    while True:
        end = min(start + content, len(ids))
        out.append(([tokenizer.cls_token_id] + ids[start:end] + [tokenizer.sep_token_id], (start, end)))
        if end >= len(ids) or (max_windows and len(out) >= max_windows):
            break
        start += step
    return out, offs


def pad_batch(seqs: list[np.ndarray], pad_id: int, extra: list[np.ndarray] | None = None, extra_pad: int = -100):
    longest = max(len(s) for s in seqs)
    ids = torch.full((len(seqs), longest), pad_id, dtype=torch.long)
    mask = torch.zeros((len(seqs), longest), dtype=torch.long)
    ex = torch.full((len(seqs), longest), extra_pad, dtype=torch.long) if extra is not None else None
    for i, s in enumerate(seqs):
        ids[i, : len(s)] = torch.from_numpy(np.asarray(s, dtype=np.int64))
        mask[i, : len(s)] = 1
        if ex is not None and extra[i] is not None:
            ex[i, : len(extra[i])] = torch.from_numpy(np.asarray(extra[i], dtype=np.int64))
    return ids, mask, ex


@torch.inference_mode()
def score_texts(model, tokenizer, texts: list[str], max_length: int = 512, stride: int = 128,
                max_windows: int | None = 8, batch_size: int = 128, device="cuda", token_probs: bool = False):
    """Per document: window log-odds (head A), window class probs (head B) [, token probs]."""
    model.eval()
    wins, owner = [], []
    for i, t in enumerate(texts):
        ws, _ = doc_windows(tokenizer, t, max_length, stride, max_windows)
        for ids, _span in ws:
            wins.append(np.asarray(ids, dtype=np.int32))
            owner.append(i)
    order = np.argsort([len(w) for w in wins], kind="stable")
    a = np.zeros(len(wins), np.float32)
    b = np.zeros((len(wins), len(FINE_CLASSES)), np.float32)
    c = [None] * len(wins) if token_probs else None
    use_amp = torch.device(device).type == "cuda"
    for s in range(0, len(order), batch_size):
        idx = order[s:s + batch_size]
        ids, mask, _ = pad_batch([wins[k] for k in idx], tokenizer.pad_token_id)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=use_amp):
            out = model(ids.to(device), mask.to(device))
        a[idx] = out["a"].float().cpu().numpy()
        b[idx] = torch.softmax(out["b"].float(), -1).cpu().numpy()
        if token_probs:
            pc = torch.sigmoid(out["c"].float()).cpu().numpy()
            for j, k in enumerate(idx):
                c[k] = pc[j, 1: len(wins[k]) - 1]
    per = [{"a": [], "b": [], "c": []} for _ in texts]
    for k, i in enumerate(owner):
        per[i]["a"].append(a[k])
        per[i]["b"].append(b[k])
        if token_probs:
            per[i]["c"].append(c[k])
    return [{"a": np.array(p["a"], np.float32), "b": np.array(p["b"], np.float32), "c": p["c"]} for p in per]


def aggregate(a: np.ndarray, method: str, k: int = 2, trim: float = 0.2) -> float:
    if len(a) == 1 or method == "mean":
        return float(a.mean())
    if method == "max":
        return float(a.max())
    if method == "topk_mean":
        return float(np.sort(a)[-k:].mean())
    if method == "trimmed_mean":
        s = np.sort(a)
        cut = int(len(s) * trim)
        s = s[cut: len(s) - cut] if len(s) - 2 * cut > 0 else s
        return float(s.mean())
    raise ValueError(method)
