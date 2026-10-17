"""Transformer detector utilities: windowing, model loading/freezing, batched scoring, aggregation."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from .common import CACHE_DIR

HF_SNAPSHOTS = CACHE_DIR / "hf" / "hub"


def local_snapshot(model_id: str, revision: str) -> Path | None:
    path = HF_SNAPSHOTS / f"models--{model_id.replace('/', '--')}" / "snapshots" / revision
    return path if (path / "config.json").exists() else None


def resolve_model(model_id: str, revision: str) -> str:
    """Prefer the pinned local snapshot; otherwise download that exact revision."""
    local = local_snapshot(model_id, revision)
    if local:
        return str(local)
    from huggingface_hub import snapshot_download

    return snapshot_download(model_id, revision=revision, cache_dir=str(HF_SNAPSHOTS),
                             allow_patterns=["*.json", "spm.model", "*.model", "pytorch_model.bin",
                                             "model.safetensors", "sentencepiece.bpe.model"])


@dataclass
class Window:
    doc_index: int
    window_index: int
    token_start: int
    token_end: int
    input_ids: list[int]


def make_windows(tokenizer, text: str, doc_index: int, max_length: int, stride: int,
                 max_windows: int | None) -> list[Window]:
    """Split one document into overlapping windows of at most `max_length` tokens.

    `stride` is the overlap between consecutive windows (HF convention).
    """
    content = max_length - 2  # [CLS] ... [SEP]
    budget = None if max_windows is None else content + (max_windows - 1) * (content - stride)
    # tokenise a bounded prefix of characters first so huge documents stay cheap
    char_budget = None if budget is None else budget * 12
    ids = tokenizer(text[:char_budget] if char_budget else text, add_special_tokens=False,
                    truncation=False)["input_ids"]
    if budget is not None:
        ids = ids[:budget]
    if not ids:
        ids = [tokenizer.unk_token_id]
    step = max(1, content - stride)
    windows = []
    start = 0
    while True:
        end = min(start + content, len(ids))
        windows.append(Window(doc_index, len(windows), start, end,
                              [tokenizer.cls_token_id] + ids[start:end] + [tokenizer.sep_token_id]))
        if end >= len(ids) or (max_windows and len(windows) >= max_windows):
            break
        start += step
    return windows


def collate(windows: list[Window], pad_id: int, labels=None):
    longest = max(len(w.input_ids) for w in windows)
    ids = torch.full((len(windows), longest), pad_id, dtype=torch.long)
    mask = torch.zeros((len(windows), longest), dtype=torch.long)
    for i, w in enumerate(windows):
        ids[i, : len(w.input_ids)] = torch.tensor(w.input_ids)
        mask[i, : len(w.input_ids)] = 1
    batch = {"input_ids": ids, "attention_mask": mask}
    if labels is not None:
        batch["labels"] = torch.tensor(labels, dtype=torch.long)
    return batch


def freeze(model, freeze_embeddings: bool, trainable_top_layers: int) -> dict:
    base = getattr(model, model.base_model_prefix)
    layers = base.encoder.layer
    n = len(layers)
    if freeze_embeddings:
        for p in base.embeddings.parameters():
            p.requires_grad = False
    if trainable_top_layers < n:
        for layer in layers[: n - trainable_top_layers]:
            for p in layer.parameters():
                p.requires_grad = False
        # DeBERTa keeps relative-position embeddings / LayerNorm on the encoder itself
        for name, p in base.encoder.named_parameters():
            if not name.startswith("layer."):
                p.requires_grad = trainable_top_layers >= n
    total = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    return {"total_params": total, "trainable_params": trainable, "layers": n,
            "trainable_top_layers": trainable_top_layers, "freeze_embeddings": freeze_embeddings}


@torch.inference_mode()
def score_windows(model, tokenizer, texts: list[str], max_length: int, stride: int, max_windows: int | None,
                  batch_size: int = 32, progress: bool = False) -> list[np.ndarray]:
    """Return, per document, the array of P(MACHINE) logits for each window."""
    model.eval()
    windows = []
    for i, t in enumerate(texts):
        windows.extend(make_windows(tokenizer, t, i, max_length, stride, max_windows))
    order = sorted(range(len(windows)), key=lambda k: len(windows[k].input_ids))
    logits = np.zeros(len(windows), dtype=np.float32)
    iterator = range(0, len(order), batch_size)
    if progress:
        from tqdm import tqdm
        iterator = tqdm(iterator, total=math.ceil(len(order) / batch_size), mininterval=30)
    for s in iterator:
        idx = order[s:s + batch_size]
        batch = collate([windows[k] for k in idx], tokenizer.pad_token_id)
        batch = {k: v.to(model.device) for k, v in batch.items()}
        with torch.autocast(model.device.type, enabled=model.device.type == "cuda"):
            out = model(**batch).logits.float()
        logits[idx] = (out[:, 1] - out[:, 0]).cpu().numpy()  # log-odds of MACHINE
    per_doc: list[list[float]] = [[] for _ in texts]
    for w, lg in zip(windows, logits):
        per_doc[w.doc_index].append(float(lg))
    return [np.array(v, dtype=np.float32) for v in per_doc]


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.asarray(x, dtype=np.float64)))


def aggregate(window_logits: list[np.ndarray], method: str, k: int = 2, trim: float = 0.2) -> np.ndarray:
    """Document log-odds from window log-odds."""
    out = np.empty(len(window_logits), dtype=np.float64)
    for i, w in enumerate(window_logits):
        if len(w) == 1 or method == "mean":
            out[i] = w.mean()
        elif method == "max":
            out[i] = w.max()
        elif method == "topk_mean":
            out[i] = np.sort(w)[-k:].mean()
        elif method == "trimmed_mean":
            s = np.sort(w)
            cut = int(len(s) * trim)
            s = s[cut: len(s) - cut] if len(s) - 2 * cut > 0 else s
            out[i] = s.mean()
        else:
            raise ValueError(method)
    return out
