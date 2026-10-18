"""F006.1.2 span-localisation training / selection / lock / single final evaluation.

    python scripts/f0612_train.py train --run S1 --parent <model dir> [--scheme binary|bio] [--alpha 0.4 --beta 0.6] ...
    python scripts/f0612_train.py summary                 # ablation table + selection (VALIDATION only)
    python scripts/f0612_train.py lock --run SFULL         # F006_1_2_MODEL_LOCK.json + packaged model
    python scripts/f0612_train.py final                    # ONE evaluation of the LOCKED model (+ parent) on the holdout
    python scripts/f0612_train.py readiness --model <dir>  # SPAN_SERVING_READINESS_EVAL of an existing model (validation)

Multi-task: shared mDeBERTa encoder (V3 architecture) + paragraph head A (binary log-odds) + token head C (binary
sigmoid, or 3-way BIO). L = alpha * paragraph BCE + beta * token loss (weighted BCE / focal / class-weighted CE).
Replay windows from the F006.1.1 training data keep head A anchored (token labels ignored on them).
Post-processing (tau, gap, min_tokens) and SPAN_ABSTAIN_THRESHOLD are chosen on VALIDATION only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f0612_spans import SpanMetrics, ai_prob_from_logits, nfc_with_map, predict_spans, token_labels  # noqa: E402
from f006_lib import log, sha256_file, write_json  # noqa: E402
from turniting_train.v3model import V3Detector, pad_batch  # noqa: E402

T = Path("/content/drive/MyDrive/turniting")
D = T / "f006_1_2"
REPO = Path(__file__).resolve().parents[1]
LOCAL = Path("/content/turniting-f0612")
MAXLEN = 512
GRID = [{"tau": t, "gap": g, "min_tokens": m, "abstain": a} for t in (0.35, 0.5, 0.65) for g in (0, 2) for m in (1, 3, 6) for a in (0.0, 0.6, 0.7)]
PARENTS = {"F006_1": T / "f006_1/models/experimental_f006_1", "F006_1_1": T / "f006_1_1/models/f006_1_1_locked", "F006": T / "f006/models/experimental_v4"}


# ------------------------------------------------------------------ model
def load_model(path, scheme: str = "binary"):
    path = Path(path)
    cfg = json.loads((path / "v3_config.json").read_text()) if (path / "v3_config.json").exists() else {}
    saved = cfg.get("span_scheme", "binary")
    from transformers import AutoModel

    bb = AutoModel.from_pretrained(path / "backbone")
    m = V3Detector(bb, bb.config.hidden_size)
    if saved == "bio":
        m.head_c = nn.Linear(bb.config.hidden_size, 3)
    state = torch.load(path / "heads.pt", map_location="cpu", weights_only=True)
    m.load_state_dict(state, strict=False)
    if scheme == "bio" and saved != "bio":  # new 3-way head, initialised from the binary head (O = -w, B/I = +w)
        w, b = m.head_c.weight.data.clone(), m.head_c.bias.data.clone()
        m.head_c = nn.Linear(bb.config.hidden_size, 3)
        m.head_c.weight.data = torch.cat([-w / 2, w / 2, w / 2])
        m.head_c.bias.data = torch.cat([-b / 2, b / 2, b / 2])
    return m


# ------------------------------------------------------------------ data
def encode_units(tok, frame: pd.DataFrame, scheme: str) -> list[dict]:
    enc = tok(frame["text"].tolist(), add_special_tokens=True, truncation=True, max_length=MAXLEN, return_offsets_mapping=True)
    out = []
    for i, r in enumerate(frame.itertuples(index=False)):
        offs = [tuple(o) for o in enc["offset_mapping"][i]]
        spans = []
        for s_, e_ in json.loads(r.spans):  # same visible-character convention as predictions (metrics only; data untouched)
            while s_ < e_ and r.text[s_].isspace():
                s_ += 1
            while e_ > s_ and r.text[e_ - 1].isspace():
                e_ -= 1
            if e_ > s_:
                spans.append([s_, e_])
        out.append({"ids": np.asarray(enc["input_ids"][i], np.int32), "offs": offs, "tl": token_labels(offs, spans, len(r.text), scheme),
                    "a": float(r.n_spans > 0), "spans": spans, "text_len": len(r.text), "text": r.text})
    return out


def replay_windows(tok, n: int, seed: int) -> list[dict]:
    """Paragraph-only windows (first 510 tokens, canonical text) from the F006.1.1 training data (V2 train + extra)."""
    if n <= 0:
        return []
    import pyarrow.compute as pc
    import pyarrow.dataset as pads

    from turniting_train.canon import canonicalize

    idx = pd.read_parquet(T / "v3/datasets/index_v2.parquet", columns=["id", "split", "status", "fine_label", "language", "domain"])
    idx = idx[(idx["split"] == "train") & (idx["status"] == "KEPT")]
    w = np.where(idx["language"] == "es", 3.0, 1.0) * np.where(idx["domain"] == "academic", 2.0, 1.0)
    ids = idx.sample(n, weights=w, random_state=seed)
    t = pads.dataset("/content/f006work/master_v2/train", format="parquet").to_table(columns=["id", "text_original", "fine_label"],
                                                                                      filter=pc.field("id").isin(ids["id"].tolist())).to_pandas()
    texts = [canonicalize(x) for x in t["text_original"]]
    enc = tok(texts, add_special_tokens=True, truncation=True, max_length=MAXLEN)
    return [{"ids": np.asarray(e, np.int32), "tl": None, "a": float(f != "HUMAN"), "replay": True} for e, f in zip(enc["input_ids"], t["fine_label"].astype(str))]


class DS(torch.utils.data.Dataset):
    def __init__(self, items):
        self.items = items

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        return self.items[i]


def collate(pad_id):
    def f(items):
        ids, mask, tl = pad_batch([x["ids"] for x in items], pad_id, [x["tl"] for x in items])
        return {"input_ids": ids, "attention_mask": mask, "a": torch.tensor([x["a"] for x in items], dtype=torch.float32), "c": tl}
    return f


# ------------------------------------------------------------------ inference + metrics
@torch.inference_mode()
def token_probs(model, items, scheme, device, bs=128) -> tuple[list[np.ndarray], np.ndarray]:
    model.eval()
    order = np.argsort([len(x["ids"]) for x in items])
    probs, para = [None] * len(items), np.zeros(len(items), np.float32)
    for s in range(0, len(order), bs):
        idx = order[s:s + bs]
        ids, mask, _ = pad_batch([items[k]["ids"] for k in idx], 0)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=str(device).startswith("cuda")):
            out = model(ids.to(device), mask.to(device))
        c = out["c"].float().cpu().numpy()
        a = out["a"].float().cpu().numpy()
        for j, k in enumerate(idx):
            n = len(items[k]["ids"])
            probs[k] = ai_prob_from_logits(c[j, :n], scheme)
            para[k] = a[j]
    return probs, para


def evaluate(items, frame, probs, para, cfg, light: bool = False) -> dict:
    """Span metrics overall + by kind / language / domain / buckets for one post-processing config."""
    groups = {"all": np.ones(len(frame), bool)}
    if light:
        groups["span_units"] = frame["n_spans"].values > 0
        k = frame["kind"].values
        mets = {g: SpanMetrics() for g in groups}
        for i, it in enumerate(items):
            pred = predict_spans(probs[i], it["offs"], cfg, it.get("text"))
            kind = {"HUMAN": "human", "HARD_NEG": "boilerplate", "REFERENCE": "reference", "METADATA": "metadata"}.get(k[i], "span")
            for g, m in groups.items():
                if m[i]:
                    m_ = mets[g]
                    m_.add(it["text_len"], it["spans"], pred, it["tl"], probs[i] >= cfg["tau"], kind)
        return {g: m.report() for g, m in mets.items()}
    k = frame["kind"].values
    groups |= {f"kind_{x.lower()}": k == x for x in np.unique(k)}
    spanish = (frame["language"] == "es").values
    aca = (frame["domain"] == "academic").values
    spanu = frame["n_spans"].values > 0
    groups |= {"spanish_span": spanish & spanu, "academic_span": aca & spanu, "mixed_span": spanu & np.isin(frame["fine_label"].values, ["MIXED", "HUMAN_EDITED_AI"]),
               "span_units": spanu, "spanish_all": spanish, "academic_all": aca}
    if "subset" in frame:
        for s in ("unseen_generator", "unseen_domain"):
            groups[s] = (frame["subset"] == s).values
    af = frame["ai_fraction_chars"].values
    for lo, hi in ((0, .10), (.10, .25), (.25, .50), (.50, .75), (.75, 1.01)):
        groups[f"ai_frac_{int(lo * 100)}_{int(min(hi, 1) * 100)}"] = spanu & (af > lo) & (af <= hi) if lo else spanu & (af <= hi)
    ns = frame["n_spans"].values
    groups |= {"spans_1": ns == 1, "spans_2_3": (ns >= 2) & (ns <= 3), "spans_4p": ns >= 4}
    mets = {g: SpanMetrics() for g in groups}
    len_b = {b: [0, 0] for b in ("1-5", "6-15", "16-40", "41-100", ">100")}  # gold spans by token length: detected(IoU>=.5) / total
    preds_all = []
    for i, it in enumerate(items):
        pred = predict_spans(probs[i], it["offs"], cfg, it.get("text"))
        preds_all.append(pred)
        tg = it["tl"]
        tp_ = probs[i] >= cfg["tau"]
        kind = {"HUMAN": "human", "HARD_NEG": "boilerplate", "REFERENCE": "reference", "METADATA": "metadata"}.get(k[i], "span")
        for g, m in groups.items():
            if m[i]:
                mets[g].add(it["text_len"], it["spans"], pred, tg, tp_, kind)
        for a_, b_ in it["spans"]:
            nt = sum(1 for s, e in it["offs"] if e > s and s >= a_ and e <= b_)
            key = "1-5" if nt <= 5 else "6-15" if nt <= 15 else "16-40" if nt <= 40 else "41-100" if nt <= 100 else ">100"
            len_b[key][1] += 1
            len_b[key][0] += any(min(p["endChar"], b_) - max(p["startChar"], a_) > 0.5 * (b_ - a_) for p in pred)
    rep = {g: m.report() for g, m in mets.items() if m.units}
    rep["span_length_buckets_recall"] = {b: v[0] / max(v[1], 1) for b, v in len_b.items()} | {"counts": {b: v[1] for b, v in len_b.items()}}
    # paragraph / span relation (no forced consistency): flagged paragraphs without spans, strong spans in negative paragraphs
    pz = 1 / (1 + np.exp(-para))
    has = np.array([bool(p) for p in preds_all])
    strong = np.array([any(s["confidence"] >= 0.8 for s in p) for p in preds_all])
    rep["paragraph_span_relation"] = {"para_pos_no_span": float(((pz >= 0.5) & ~has).mean()), "para_pos_span": float(((pz >= 0.5) & has).mean()),
                                      "para_neg_no_span": float(((pz < 0.5) & ~has).mean()), "para_neg_strong_span": float(((pz < 0.5) & strong).mean()),
                                      "para_neg_strong_span_count": int(((pz < 0.5) & strong).sum())}
    return rep


def span_objective(rep: dict) -> float:
    a = rep["span_units"]
    fh = rep["all"]["false_highlight"]
    hfh = fh.get("human", {}).get("false_highlight_rate", 0.0)
    rfh = fh.get("reference", {}).get("false_highlight_rate", 0.0)
    mfh = fh.get("metadata", {}).get("false_highlight_rate", 0.0)
    return (0.4 * a["char_f1"] + 0.4 * a["span_overlap_f1"] + 0.2 * a["token_f1"] - 3 * max(0, hfh - 0.03) - 5 * max(0, rfh - 0.015) - 5 * max(0, mfh - 0.015))


def choose_postproc(items, frame, probs, para) -> tuple[dict, dict, list]:
    rows = []
    for cfg in GRID:
        rep = evaluate(items, frame, probs, para, cfg, light=True)
        rows.append({"cfg": cfg, "objective": span_objective(rep), "rep": rep})
    best = max(rows, key=lambda r: r["objective"])
    full = evaluate(items, frame, probs, para, best["cfg"])
    return best["cfg"], full, [{"cfg": r["cfg"], "objective": r["objective"], "char_f1": r["rep"]["span_units"]["char_f1"],
                                       "span_overlap_f1": r["rep"]["span_units"]["span_overlap_f1"],
                                       "human_fh": r["rep"]["all"]["false_highlight"].get("human", {}).get("false_highlight_rate")} for r in rows]


def paragraph_check(model, tok, device, frame=None) -> dict:
    """Paragraph detector on F006.1.1 VALIDATION (doc logits, canonical / trimmed mean): macro F1, human FPR, Spanish FPR
    at the threshold that reproduces the parent's recall (same detection power -> compare false positives)."""
    from f006_score import doc_logits

    val = frame if frame is not None else pd.read_parquet(T / "f006_1_1/datasets/f006_1_1_validation.parquet", columns=["id", "label", "language", "text_original"])
    lg = doc_logits(model, tok, val["text_original"].tolist(), "canonical", "trimmed_mean", 8, device=device)
    return {"logits": lg, "labels": val["label"].values, "spanish": (val["language"] == "es").values}


def para_metrics(lg, y, es, recall_target=None) -> dict:
    pos = np.sort(lg[y == 1])
    if recall_target is None:  # parent: threshold at overall human FPR 0.05
        thr = float(np.quantile(lg[y == 0], 0.95))
    else:
        thr = float(np.quantile(pos, 1 - recall_target)) if len(pos) else 0.0
    pred = lg >= thr
    rec = float(pred[y == 1].mean())
    fpr = float(pred[y == 0].mean())
    es_fpr = float(pred[(y == 0) & es].mean()) if ((y == 0) & es).any() else None
    f1s = []
    for c in (0, 1):
        tp = ((pred == c) & (y == c)).sum()
        p_ = tp / max((pred == c).sum(), 1)
        r_ = tp / max((y == c).sum(), 1)
        f1s.append(2 * p_ * r_ / max(p_ + r_, 1e-9))
    return {"threshold_logit": thr, "recall": rec, "human_fpr": fpr, "spanish_fpr": es_fpr, "macro_f1": float(np.mean(f1s))}


# ------------------------------------------------------------------ train
def train(a) -> int:
    from transformers import AutoTokenizer, get_linear_schedule_with_warmup

    torch.manual_seed(a.seed)
    random.seed(a.seed)
    device = torch.device("cpu" if a.smoke else "cuda")
    if a.smoke:  # CPU end-to-end check of the whole train/eval path on a handful of units (writes under /content/f0612_smoke)
        a.windows, a.val_cap, a.batch = 48, 6, 8
    run_dir = (Path("/content/f0612_smoke") if a.smoke else D / "runs") / a.run
    run_dir.mkdir(parents=True, exist_ok=True)
    parent = PARENTS.get(a.parent, Path(a.parent))
    tok = AutoTokenizer.from_pretrained(parent / "backbone")
    tr = pd.read_parquet(D / "datasets" / "f006_1_2_span_train.parquet")
    va = pd.read_parquet(D / "datasets" / "f006_1_2_span_validation.parquet")
    if a.val_cap:
        va = va.groupby("kind", group_keys=False).apply(lambda g: g.sample(min(len(g), a.val_cap), random_state=1))
    n_span = int(a.windows * (1 - a.replay_frac))
    w = np.where(tr["n_spans"] > 0, a.span_up, 1.0)
    tr_s = tr.sample(n_span, replace=n_span > len(tr), weights=w, random_state=a.seed)
    items = encode_units(tok, tr_s, a.scheme) + replay_windows(tok, a.windows - n_span, a.seed)
    vitems = encode_units(tok, va, a.scheme)
    log(f"{a.run}: parent={a.parent} scheme={a.scheme} alpha={a.alpha} beta={a.beta} tok_loss={a.tok_loss} pos_w={a.pos_weight} "
        f"windows={len(items):,} (replay {a.replay_frac:.0%}) validation units {len(va):,}")
    model = load_model(parent, a.scheme).to(device)
    if a.grad_ckpt:
        model.backbone.gradient_checkpointing_enable()
    dl = torch.utils.data.DataLoader(DS(items), batch_size=a.batch, shuffle=True, collate_fn=collate(tok.pad_token_id), num_workers=0 if a.smoke else 4,
                                     pin_memory=not a.smoke)
    total = len(dl) * a.epochs
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01, fused=device.type == "cuda")
    sched = get_linear_schedule_with_warmup(opt, int(0.06 * total), total)
    bce = nn.BCEWithLogitsLoss(reduction="none")
    cw = torch.tensor([1.0, a.pos_weight, a.pos_weight], device=device)

    def tok_loss(c, tl):
        valid = tl != -100
        if not valid.any():
            return torch.zeros((), device=device)
        if a.scheme == "bio":
            lg, y = c[valid], tl[valid]
            if a.tok_loss == "focal":
                lp = torch.log_softmax(lg, -1).gather(1, y[:, None]).squeeze(1)
                return (-(1 - lp.exp()) ** 2 * lp * cw[y]).mean()
            return nn.functional.cross_entropy(lg, y, weight=cw)
        lg, y = c[valid], tl[valid].float()
        l_ = bce(lg, y)
        if a.tok_loss == "focal":
            pt = torch.exp(-l_)
            l_ = (1 - pt) ** 2 * l_
        wt = torch.where(y > 0.5, torch.full_like(y, a.pos_weight), torch.ones_like(y))
        return (wt * l_).sum() / wt.sum()

    # parent references (validation) once per parent
    pref = (run_dir.parent if a.smoke else D / "runs") / f"PARENT_{a.parent}_validation.json"
    pframe = None
    if a.smoke:
        pframe = pd.read_parquet(T / "f006_1_1/datasets/f006_1_1_validation.parquet", columns=["id", "label", "language", "text_original"]).sample(120, random_state=1)
    if not pref.exists():  # parent as-is (binary head C), same validation units
        pm = load_model(parent, "binary").to(device)
        pp, ppara = token_probs(pm, vitems, "binary", device)
        cfg, rep, _ = choose_postproc(vitems, va, pp, ppara)
        para = paragraph_check(pm, tok, device, pframe)
        pmet = para_metrics(para["logits"], para["labels"], para["spanish"])
        write_json(pref, {"postproc": cfg, "span": rep, "objective": span_objective(rep), "paragraph": pmet})
        del pm
        torch.cuda.empty_cache()
    parent_ref = json.loads(pref.read_text())
    log(f"  parent {a.parent}: span char F1 {parent_ref['span']['span_units']['char_f1']:.3f} overlap F1 {parent_ref['span']['span_units']['span_overlap_f1']:.3f} "
        f"paragraph macroF1 {parent_ref['paragraph']['macro_f1']:.3f}")
    model.train()
    step, t0 = 0, time.time()
    for ep in range(a.epochs):
        for b in dl:
            ids, mask = b["input_ids"].to(device, non_blocking=True), b["attention_mask"].to(device, non_blocking=True)
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
                out = model(ids, mask)
            la = bce(out["a"].float(), b["a"].to(device)).mean()
            lc = tok_loss(out["c"].float(), b["c"].to(device))
            loss = a.alpha * la + a.beta * lc
            if not torch.isfinite(loss):
                raise RuntimeError(f"non-finite loss at step {step}")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
            step += 1
            if step % 100 == 0:
                log(f"  step {step}/{total} loss a={la.item():.4f} c={lc.item():.4f} {step * a.batch / (time.time() - t0):.0f} win/s "
                    f"mem={(torch.cuda.max_memory_allocated() / 1e9) if device.type == 'cuda' else 0:.1f}GB")
    probs, para = token_probs(model, vitems, a.scheme, device)
    cfg, rep, grid = choose_postproc(vitems, va, probs, para)
    pc_ = paragraph_check(model, tok, device, pframe)
    pnew = para_metrics(pc_["logits"], pc_["labels"], pc_["spanish"], recall_target=parent_ref["paragraph"]["recall"])
    pp = parent_ref["paragraph"]
    regression = {"macro_f1_pp": 100 * (pp["macro_f1"] - pnew["macro_f1"]), "human_fpr_pp": 100 * (pnew["human_fpr"] - pp["human_fpr"]),
                  "spanish_fpr_pp": 100 * ((pnew["spanish_fpr"] or 0) - (pp["spanish_fpr"] or 0))}
    reg_ok = regression["macro_f1_pp"] <= 1.5 and regression["human_fpr_pp"] <= 1.0 and regression["spanish_fpr_pp"] <= 1.0
    obj = span_objective(rep)
    score = obj - 0.05 * max(0, regression["macro_f1_pp"] - 1.5) - 0.05 * max(0, regression["human_fpr_pp"] - 1.0) - 0.05 * max(0, regression["spanish_fpr_pp"] - 1.0)
    res = {"run": a.run, "args": vars(a), "postproc": cfg, "validation": rep, "span_objective": obj, "selection_score": score,
           "paragraph": pnew, "paragraph_parent": pp, "paragraph_regression": regression, "paragraph_regression_ok": reg_ok,
           "parent_span": parent_ref["span"]["span_units"], "grid": grid, "seconds": round(time.time() - t0, 1)}
    write_json(run_dir / "result.json", res)
    if not a.smoke:
        model.save(LOCAL / a.run, tok, {"span_scheme": a.scheme, "postproc": cfg, "parent": a.parent})
        shutil.copytree(LOCAL / a.run, run_dir / "model", dirs_exist_ok=True)
    s = rep["span_units"]
    log(f"  {a.run}: score {score:.4f} charF1 {s['char_f1']:.3f} spanF1 {s['span_overlap_f1']:.3f} tokF1 {s['token_f1']:.3f} "
        f"humanFH {rep['all']['false_highlight'].get('human', {}).get('false_highlight_rate', 0):.3f} reg {json.dumps({k: round(v, 2) for k, v in regression.items()})} cfg {cfg}")
    return 0


def summary(a) -> int:
    rows = []
    for p in sorted((D / "runs").glob("*/result.json")):
        r = json.loads(p.read_text())
        s = r["validation"]["span_units"]
        fh = r["validation"]["all"]["false_highlight"]
        rows.append({"run": r["run"], "parent": r["args"]["parent"], "scheme": r["args"]["scheme"], "alpha": r["args"]["alpha"], "beta": r["args"]["beta"],
                     "tok_loss": r["args"]["tok_loss"], "pos_weight": r["args"]["pos_weight"], "windows": r["args"]["windows"], "score": r["selection_score"],
                     "char_f1": s["char_f1"], "span_overlap_f1": s["span_overlap_f1"], "token_f1": s["token_f1"], "iou": s["iou_mean"],
                     "human_fh": fh.get("human", {}).get("false_highlight_rate"), "reference_fh": fh.get("reference", {}).get("false_highlight_rate"),
                     "metadata_fh": fh.get("metadata", {}).get("false_highlight_rate"), "regression": r["paragraph_regression"], "regression_ok": r["paragraph_regression_ok"],
                     "postproc": r["postproc"], "full": r["args"]["windows"] >= 250000})
    abl = [r for r in rows if not r["full"]]
    best = max([r for r in abl if r["regression_ok"]] or abl, key=lambda r: r["score"]) if abl else None
    out = {"set": "F006_1_2_SPAN_VALIDATION", "runs": rows, "best_ablation": best}
    write_json(D / "reports" / "ablation_summary.json", out)
    write_json(REPO / "reports" / "f006_1_2" / "ablation_summary.json", out)
    for r in sorted(rows, key=lambda r: -r["score"]):
        log(f"{r['run']:<14} {r['score']:.4f} charF1 {r['char_f1']:.3f} spanF1 {r['span_overlap_f1']:.3f} humanFH {r['human_fh']} reg_ok {r['regression_ok']}")
    if best:
        (D / "runs" / "BEST_ABLATION.json").write_text(json.dumps(best, indent=2, default=str))
    return 0


# ------------------------------------------------------------------ robustness views (offset-preserving)
def perturb(text: str, spans, kind: str, rng) -> tuple[str, list]:
    out, mp_ = [], []
    hom = {"a": "а", "e": "е", "o": "о", "c": "с", "p": "р"}
    for i, ch in enumerate(text):
        mp_.append(len("".join(out)))
        if kind == "zero_width" and ch == " " and rng.random() < 0.3:
            out.append(" ​")
        elif kind == "homoglyph" and ch in hom and rng.random() < 0.15:
            out.append(hom[ch])
        elif kind == "line_breaks" and ch == " " and rng.random() < 0.05:
            out.append("\n")
        elif kind == "extra_whitespace" and ch == " " and rng.random() < 0.2:
            out.append("  ")
        elif kind == "punctuation" and ch in ",;" and rng.random() < 0.5:
            out.append("")
        else:
            out.append(ch)
    new = "".join(out)
    mp_.append(len(new))
    return new, [[mp_[a_], mp_[b_]] for a_, b_ in spans if mp_[b_] > mp_[a_]]


def lock(a) -> int:
    best = json.loads((D / "runs" / "BEST_ABLATION.json").read_text())
    r = json.loads((D / "runs" / a.run / "result.json").read_text())
    md = D / "runs" / a.run / "model"
    dst = D / "models" / "f006_1_2_locked"
    shutil.copytree(md, dst, dirs_exist_ok=True)
    lockobj = {"name": "F006_1_2_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "run": a.run,
               "checkpoint_sha256": {f.name: sha256_file(f) for f in [dst / "heads.pt", dst / "backbone" / "model.safetensors"] if f.exists()},
               "parent": r["args"]["parent"], "best_ablation": best["run"], "training_config": r["args"],
               "loss_weights": {"alpha": r["args"]["alpha"], "beta": r["args"]["beta"], "token_loss": r["args"]["tok_loss"], "pos_weight": r["args"]["pos_weight"]},
               "label_scheme": r["args"]["scheme"], "token_threshold": r["postproc"]["tau"], "span_abstain_threshold": r["postproc"]["abstain"],
               "postproc": r["postproc"], "preprocessing": "NFC with char map; target paragraph only; tokenizer offset_mapping; max 512 tokens",
               "tokenizer": "mDeBERTa-v3 (parent backbone)", "seed": r["args"]["seed"],
               "dataset_manifest_sha256": sha256_file(D / "manifests" / "F006_1_2_DATASET_MANIFEST.json"),
               "holdout_lock_sha256": sha256_file(D / "manifests" / "F006_1_2_HOLDOUT_LOCK.json"),
               "split_hashes": {k: v for k, v in json.loads((D / "manifests" / "F006_1_2_HOLDOUT_LOCK.json").read_text()).items() if k.endswith("sha256") or k == "split_hash"},
               "source_commit": __import__("subprocess").run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=REPO).stdout.strip(),
               "validation": {"span_units": r["validation"]["span_units"], "paragraph_regression": r["paragraph_regression"]}}
    write_json(D / "manifests" / "F006_1_2_MODEL_LOCK.json", lockobj)
    write_json(REPO / "reports" / "f006_1_2" / "model_lock.json", lockobj)
    write_json(REPO / "reports" / "f006_1_2" / "validation_metrics.json", {"run": a.run, "validation": r["validation"], "postproc": r["postproc"],
                                                                          "paragraph": r["paragraph"], "paragraph_parent": r["paragraph_parent"]})
    log(f"LOCKED {a.run} -> {dst}")
    return 0


def final(a) -> int:
    from transformers import AutoTokenizer

    done = D / "manifests" / "F006_1_2_FINAL_EVAL_DONE.json"
    if done.exists():
        log("final evaluation already ran once")
        return 0
    lk = json.loads((D / "manifests" / "F006_1_2_MODEL_LOCK.json").read_text())
    hl = json.loads((D / "manifests" / "F006_1_2_HOLDOUT_LOCK.json").read_text())
    hp = D / "datasets" / "f006_1_2_span_final_holdout.parquet"
    assert sha256_file(hp) == hl["holdout_file_sha256"], "holdout changed after lock"
    device = torch.device("cuda")
    ho = pd.read_parquet(hp)
    md = D / "models" / "f006_1_2_locked"
    tok = AutoTokenizer.from_pretrained(md / "backbone")
    scheme, cfg = lk["label_scheme"], lk["postproc"]
    model = load_model(md, scheme).to(device)
    items = encode_units(tok, ho, scheme)
    probs, para = token_probs(model, items, scheme, device)
    rep = evaluate(items, ho, probs, para, cfg)
    rob = {}
    span_rows = ho[ho["n_spans"] > 0].sample(min(3000, int((ho["n_spans"] > 0).sum())), random_state=7)
    for kind in ("zero_width", "homoglyph", "line_breaks", "extra_whitespace", "punctuation"):
        rng = random.Random(f"rob:{kind}")
        pr = span_rows.copy()
        pt = [perturb(t, json.loads(s), kind, rng) for t, s in zip(pr["text"], pr["spans"])]
        pr["text"], pr["spans"] = [x[0] for x in pt], [json.dumps(x[1]) for x in pt]
        it = encode_units(tok, pr, scheme)
        p_, pa_ = token_probs(model, it, scheme, device)
        rob[kind] = evaluate(it, pr, p_, pa_, cfg)["all"]
    base_it = encode_units(tok, span_rows, scheme)
    bp, bpa = token_probs(model, base_it, scheme, device)
    rob["clean_same_units"] = evaluate(base_it, span_rows, bp, bpa, cfg)["all"]
    # parent on the same holdout (span head as-is + paragraph regression on holdout paragraphs)
    parent = PARENTS.get(lk["parent"], Path(lk["parent"]))
    pref = json.loads((D / "runs" / f"PARENT_{lk['parent']}_validation.json").read_text())
    pm = load_model(parent, "binary").to(device)
    pitems = encode_units(tok, ho, "binary")
    pprobs, ppara = token_probs(pm, pitems, "binary", device)
    prep = evaluate(pitems, ho, pprobs, ppara, pref["postproc"]) if "postproc" in pref else None
    y = (ho["n_spans"] > 0).astype(int).values
    es = (ho["language"] == "es").values
    p_par = para_metrics(ppara, y, es)
    n_par = para_metrics(para, y, es, recall_target=p_par["recall"])
    regression = {"macro_f1_pp": 100 * (p_par["macro_f1"] - n_par["macro_f1"]), "human_fpr_pp": 100 * (n_par["human_fpr"] - p_par["human_fpr"]),
                  "spanish_fpr_pp": 100 * ((n_par["spanish_fpr"] or 0) - (p_par["spanish_fpr"] or 0))}
    s = rep["span_units"]
    fh = rep["all"]["false_highlight"]
    g = lambda k, m: rep.get(k, {}).get(m)  # noqa: E731
    gates = {"A_token_f1_ge_0.88": s["token_f1"] >= 0.88, "B_char_f1_ge_0.88": s["char_f1"] >= 0.88, "C_span_overlap_f1_ge_0.86": s["span_overlap_f1"] >= 0.86,
             "D_human_false_highlight_le_0.05": fh.get("human", {}).get("false_highlight_rate", 1) <= 0.05,
             "E_spanish_span_f1_ge_0.86": (g("spanish_span", "span_overlap_f1") or 0) >= 0.86, "F_academic_span_f1_ge_0.85": (g("academic_span", "span_overlap_f1") or 0) >= 0.85,
             "G_mixed_span_f1_ge_0.84": (g("mixed_span", "span_overlap_f1") or 0) >= 0.84,
             "H_reference_false_highlight_le_0.02": fh.get("reference", {}).get("false_highlight_rate", 1) <= 0.02,
             "I_metadata_false_highlight_le_0.02": fh.get("metadata", {}).get("false_highlight_rate", 1) <= 0.02,
             "J_leakage_0": json.loads((D / "reports" / "leakage_report.json").read_text())["result"] == "PASS",
             "PARAGRAPH_REGRESSION": regression["macro_f1_pp"] <= 1.5 and regression["human_fpr_pp"] <= 1.0 and regression["spanish_fpr_pp"] <= 1.0}
    ok = all(gates.values())
    name = "CANDIDATE_SPAN_MODEL_V1" if ok else "EXPERIMENTAL_SPAN_MODEL_V1"
    dst = D / "models" / name.lower()
    shutil.copytree(md, dst, dirs_exist_ok=True)
    out = {"set": "F006_1_2_SPAN_FINAL_HOLDOUT", "evaluatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "units": int(len(ho)), "lock": lk["run"],
           "postproc": cfg, "metrics": rep, "robustness": rob, "parent": {"name": lk["parent"], "span": prep["span_units"] if prep else None,
                                                                         "false_highlight": prep["all"]["false_highlight"] if prep else None},
           "paragraph_parent": p_par, "paragraph_new": n_par, "paragraph_regression": regression, "gates": gates, "gates_passed": ok,
           "model_name": name, "model_status": "CANDIDATE_FOR_LOCAL_INTEGRATION" if ok else "EXPERIMENTAL", "model_path": str(dst)}
    write_json(D / "reports" / "final_holdout.json", out)
    write_json(REPO / "reports" / "f006_1_2" / "final_holdout.json", out)
    # aggregated error analysis (counts + short synthetic-free excerpts are NOT stored: only categories / rates)
    ea = {"false_positive_human_units": int(sum(1 for i, it in enumerate(items) if not it["spans"] and predict_spans(probs[i], it["offs"], cfg, it.get("text")))),
          "missed_ai_spans": int(sum(1 for i, it in enumerate(items) for a_, b_ in it["spans"]
                                     if not any(min(p["endChar"], b_) > max(p["startChar"], a_) for p in predict_spans(probs[i], it["offs"], cfg, it.get("text"))))),
          "boundary": {"start_mae": s["boundary_start_mae"], "end_mae": s["boundary_end_mae"], "span_length_error": s["span_length_error"]},
          "reference_false_highlight": fh.get("reference"), "metadata_false_highlight": fh.get("metadata"), "boilerplate_false_highlight": fh.get("boilerplate"),
          "mixed_by_ai_fraction": {k: {m: v.get(m) for m in ("span_overlap_precision", "span_overlap_recall", "iou_mean")} for k, v in rep.items() if k.startswith("ai_frac_")},
          "span_length_recall": rep["span_length_buckets_recall"], "paragraph_span_relation": rep["paragraph_span_relation"]}
    write_json(REPO / "reports" / "f006_1_2" / "span_error_analysis.json", ea)
    write_json(done, {"evaluatedAt": out["evaluatedAt"], "model": name})
    log(f"FINAL {name}: gates {gates}")
    return 0


def readiness(a) -> int:
    """SPAN_SERVING_READINESS_EVAL: an existing model's head C with validation-chosen post-processing (validation only)."""
    from transformers import AutoTokenizer

    device = torch.device("cuda")
    md = PARENTS.get(a.model, Path(a.model))
    tok = AutoTokenizer.from_pretrained(md / "backbone")
    va = pd.read_parquet(D / "datasets" / "f006_1_2_span_validation.parquet")
    model = load_model(md, "binary").to(device)
    it = encode_units(tok, va, "binary")
    p, pa = token_probs(model, it, "binary", device)
    cfg, rep, grid = choose_postproc(it, va, p, pa)
    s = rep["span_units"]
    fh = rep["all"]["false_highlight"]
    ready = s["span_overlap_f1"] >= 0.86 and s["char_f1"] >= 0.88 and fh.get("human", {}).get("false_highlight_rate", 1) <= 0.05
    out = {"model": str(md), "postproc": cfg, "validation": rep, "SPAN_SERVING_READY_ON_VALIDATION": ready,
           "status": "NO_ADDITIONAL_TRAINING_REQUIRED" if ready else "ADDITIONAL_TRAINING_REQUIRED"}
    write_json(D / "reports" / f"readiness_{Path(md).name}.json", out)
    write_json(REPO / "reports" / "f006_1_2" / f"readiness_{Path(md).name}.json", out)
    log(f"readiness {md}: {out['status']} spanF1 {s['span_overlap_f1']:.3f} charF1 {s['char_f1']:.3f} humanFH {fh.get('human', {}).get('false_highlight_rate')}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--run", required=True)
    t.add_argument("--parent", default="F006_1_1")
    t.add_argument("--scheme", default="binary", choices=["binary", "bio"])
    t.add_argument("--alpha", type=float, default=0.4)
    t.add_argument("--beta", type=float, default=0.6)
    t.add_argument("--tok-loss", default="weighted", choices=["weighted", "focal"])
    t.add_argument("--pos-weight", type=float, default=2.0)
    t.add_argument("--windows", type=int, default=120000)
    t.add_argument("--replay-frac", type=float, default=0.25)
    t.add_argument("--span-up", type=float, default=2.0)
    t.add_argument("--lr", type=float, default=1.5e-5)
    t.add_argument("--epochs", type=int, default=1)
    t.add_argument("--batch", type=int, default=64)
    t.add_argument("--val-cap", type=int, default=0)
    t.add_argument("--grad-ckpt", action="store_true")
    t.add_argument("--smoke", action="store_true")
    t.add_argument("--seed", type=int, default=61206)
    sub.add_parser("summary")
    lk = sub.add_parser("lock")
    lk.add_argument("--run", required=True)
    sub.add_parser("final")
    rd = sub.add_parser("readiness")
    rd.add_argument("--model", required=True)
    a = ap.parse_args()
    return {"train": train, "summary": summary, "lock": lock, "final": final, "readiness": readiness}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
