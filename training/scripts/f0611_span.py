"""F006.1.1: AI-span evaluation for V3-architecture models (head C): token P/R/F1, char P/R/F1, IoU, boundary MAE.

Span docs are scored on the RAW text (offsets refer to it; head C is trained on the raw view of span docs).
Token probability = mean over the overlapping 512/128 windows; a token is AI when p >= 0.5; predicted char
mask = union of the predicted tokens' character offsets. Boundary MAE: for every gold span with an overlapping
predicted span, mean(|start diff|, |end diff|) in characters (match rate reported separately).
"""

from __future__ import annotations

import json

import numpy as np


def _spans_from_mask(mask: np.ndarray) -> list[tuple[int, int]]:
    out, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            out.append((i, j))
            i = j
        else:
            i += 1
    return out


def span_eval(model, tok, texts: list[str], spans_json: list, device="cuda", batch_size=128, max_len=512, stride=128) -> dict:
    import torch

    from turniting_train.v3model import pad_batch

    content, step = max_len - 2, max_len - 2 - stride
    tp = fp = fn = tn = 0
    ctp = cfp = cfn = 0
    ious, bmae, matched, golds = [], [], 0, 0
    model.eval()
    for text, sj in zip(texts, spans_json):
        gold = json.loads(sj) if isinstance(sj, str) else (sj or [])
        enc = tok(text, add_special_tokens=False, return_offsets_mapping=True, truncation=False)
        ids, offs = enc["input_ids"], enc["offset_mapping"]
        if not ids:
            continue
        wins, starts, s = [], [], 0
        while True:
            e = min(s + content, len(ids))
            wins.append([tok.cls_token_id] + ids[s:e] + [tok.sep_token_id])
            starts.append(s)
            if e >= len(ids):
                break
            s += step
        prob, cnt = np.zeros(len(ids)), np.zeros(len(ids))
        with torch.inference_mode():
            for b in range(0, len(wins), batch_size):
                chunk = wins[b:b + batch_size]
                t, m, _ = pad_batch([np.asarray(w) for w in chunk], tok.pad_token_id)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=str(device).startswith("cuda")):
                    c = torch.sigmoid(model(t.to(device), m.to(device))["c"].float()).cpu().numpy()
                for k, w in enumerate(chunk):
                    s0 = starts[b + k]
                    n = len(w) - 2
                    prob[s0:s0 + n] += c[k, 1:1 + n]
                    cnt[s0:s0 + n] += 1
        prob /= np.maximum(cnt, 1)
        cmask = np.zeros(len(text) + 1, bool)
        for g in gold:
            cmask[max(0, int(g[0])):min(len(text), int(g[1]))] = True
        cum = np.concatenate([[0], np.cumsum(cmask)])
        ytok = np.array([cum[min(e, len(text))] - cum[min(s_, len(text))] > 0 for s_, e in offs])
        ptok = prob >= 0.5
        tp += int((ptok & ytok).sum()); fp += int((ptok & ~ytok).sum()); fn += int((~ptok & ytok).sum()); tn += int((~ptok & ~ytok).sum())
        pmask = np.zeros(len(text) + 1, bool)
        for (s_, e), p_ in zip(offs, ptok):
            if p_:
                pmask[s_:e] = True
        ctp += int((pmask & cmask).sum()); cfp += int((pmask & ~cmask).sum()); cfn += int((~pmask & cmask).sum())
        union = int((pmask | cmask).sum())
        ious.append((pmask & cmask).sum() / union if union else 1.0)
        pspans = _spans_from_mask(pmask)
        for gs, ge in [(int(a[0]), int(a[1])) for a in gold]:
            golds += 1
            cand = [(ps, pe) for ps, pe in pspans if min(pe, ge) > max(ps, gs)]
            if cand:
                ps, pe = max(cand, key=lambda x: min(x[1], ge) - max(x[0], gs))
                bmae.append((abs(ps - gs) + abs(pe - ge)) / 2)
                matched += 1

    def prf(a, b, c):
        p = a / max(a + b, 1)
        r = a / max(a + c, 1)
        return p, r, 2 * p * r / max(p + r, 1e-9)

    tP, tR, tF = prf(tp, fp, fn)
    cP, cR, cF = prf(ctp, cfp, cfn)
    return {"docs": len(texts), "token_precision": tP, "token_recall": tR, "token_f1": tF, "token_fpr": fp / max(fp + tn, 1),
            "char_precision": cP, "char_recall": cR, "char_f1": cF, "iou_mean": float(np.mean(ious)) if ious else None,
            "boundary_mae_chars": float(np.mean(bmae)) if bmae else None, "gold_span_match_rate": matched / max(golds, 1), "gold_spans": golds}
