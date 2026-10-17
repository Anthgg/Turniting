"""Fast document scoring for V3-architecture models (same windows as v3model.doc_windows, parallel CPU side).

canonicalize -> multiprocessing pool; tokenization -> batched fast tokenizer; windows built exactly like
v3model.doc_windows (char budget, token budget, stride); GPU inference length-sorted in large batches.
"""

from __future__ import annotations

import multiprocessing as mp
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.canon import canonicalize  # noqa: E402
from turniting_train.v3model import aggregate, pad_batch  # noqa: E402

_POOL = None


def _pool():
    global _POOL
    if _POOL is None:
        ctx = mp.get_context("fork" if "fork" in mp.get_all_start_methods() else "spawn")
        _POOL = ctx.Pool(max(1, min((os.cpu_count() or 2) - 1, 11)))
    return _POOL


def canon_many(texts: list[str]) -> list[str]:
    if len(texts) < 2000:
        return [canonicalize(t) for t in texts]
    return _pool().map(canonicalize, texts, chunksize=256)


def windows_for(tok, texts: list[str], max_length=512, stride=128, max_windows: int | None = 8):
    content = max_length - 2
    budget = None if max_windows is None else content + (max_windows - 1) * (content - stride)
    cb = None if budget is None else budget * 12
    clipped = [t[:cb] if cb else t for t in texts]
    enc = tok(clipped, add_special_tokens=False, truncation=False)["input_ids"]
    step = max(1, content - stride)
    wins, owner = [], []
    for i, ids in enumerate(enc):
        if budget is not None:
            ids = ids[:budget]
        if not ids:
            ids = [tok.unk_token_id]
        start, n = 0, 0
        while True:
            end = min(start + content, len(ids))
            wins.append(np.asarray([tok.cls_token_id] + ids[start:end] + [tok.sep_token_id], np.int32))
            owner.append(i)
            n += 1
            if end >= len(ids) or (max_windows and n >= max_windows):
                break
            start += step
    return wins, np.asarray(owner)


def doc_logits(model, tok, texts: list[str], view: str = "canonical", aggregation: str = "mean", max_windows: int = 8,
               device="cuda", batch_size: int = 512, chunk: int = 50000) -> np.ndarray:
    """Head-A document log-odds. view: canonical | raw | avg (mean of both views' doc logits)."""
    import torch

    views = {"canonical": ["canonical"], "raw": ["raw"]}.get(view, ["canonical", "raw"])
    res = []
    model.eval()
    for v in views:
        out = np.zeros(len(texts), np.float64)
        for s in range(0, len(texts), chunk):
            part = texts[s:s + chunk]
            part = canon_many(part) if v == "canonical" else part
            wins, owner = windows_for(tok, part, 512, 128, max_windows)
            order = np.argsort([len(w) for w in wins], kind="stable")
            a = np.zeros(len(wins), np.float32)
            with torch.inference_mode():
                for i in range(0, len(order), batch_size):
                    idx = order[i:i + batch_size]
                    ids, mask, _ = pad_batch([wins[k] for k in idx], tok.pad_token_id)
                    with torch.autocast("cuda", dtype=torch.bfloat16, enabled=str(device).startswith("cuda")):
                        a[idx] = model(ids.to(device), mask.to(device))["a"].float().cpu().numpy()
            per = [[] for _ in part]
            for k, o in enumerate(owner):
                per[o].append(a[k])
            out[s:s + len(part)] = [aggregate(np.asarray(x, np.float32), aggregation) for x in per]
        res.append(out)
    return np.mean(res, axis=0)
