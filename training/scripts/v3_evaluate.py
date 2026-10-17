"""Evaluate BEST_BASELINE, CANDIDATE_MODEL_V2 and the V3 models on the frozen V2/V1 evaluation sets.

    python scripts/v3_evaluate.py --work /content/v3work --out <drive>/v3/reports/eval \
        --model CANDIDATE_MODEL_V2=<drive>/workdir/models/gpu/calibrated_spanish_academic \
        --model TURNITING_RESEARCH_V3_GLOBAL=<drive>/v3/models/global ... [--model BEST_BASELINE=<dir>]

Positive class everywhere = MACHINE_SIGNAL (AI_GENERATED, PARAPHRASED_AI, AI_EDITED, HUMAN_EDITED_AI,
MIXED). Each model uses its own BALANCED threshold chosen on its own validation set. Test sets are
read here only, once, after every model choice was made on validation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train import adapters_v2 as A  # noqa: E402
from turniting_train.calibration import Calibrator  # noqa: E402
from turniting_train.canon import canonicalize  # noqa: E402
from turniting_train.common import utc_now, write_json  # noqa: E402
from turniting_train.metrics import binary_metrics, brier, ece_score  # noqa: E402
from turniting_train.v3model import V3Detector, aggregate, score_texts  # noqa: E402

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def sig(x):
    return 1 / (1 + np.exp(-np.asarray(x, dtype=np.float64)))


# ------------------------------------------------------------------ scorers

class V3Scorer:
    kind = "v3"

    def __init__(self, path: Path):
        from transformers import AutoTokenizer

        self.path = path
        self.model = V3Detector.load(path, DEVICE)
        self.tok = AutoTokenizer.from_pretrained(path / "backbone")
        self.icfg = json.loads((path / "inference_config.json").read_text())
        cal = path / "calibration.json"
        self.cal = Calibrator.from_dict(json.loads(cal.read_text())["selected"]) if cal.exists() else None
        th = json.loads((path / "thresholds.json").read_text())
        self.threshold = th["BALANCED"]["threshold"]
        self.thresholds = {k: v["threshold"] for k, v in th.items() if isinstance(v, dict) and "threshold" in v}

    def _views(self, texts):
        v = self.icfg["view"]
        if v == "raw":
            return [texts]
        if v == "canonical":
            return [[canonicalize(t) for t in texts]]
        return [[canonicalize(t) for t in texts], texts]

    def doc_probs(self, texts: list[str]) -> tuple[np.ndarray, np.ndarray]:
        logits, fine = [], None
        for view in self._views(texts):
            sc = score_texts(self.model, self.tok, view, self.icfg["max_length"], self.icfg["stride"],
                             self.icfg["max_windows_per_doc"], batch_size=256, device=DEVICE)
            logits.append(np.array([aggregate(s["a"], self.icfg["aggregation"]) for s in sc]))
            if fine is None:
                fine = np.array([s["b"].mean(0) for s in sc])
        lg = np.mean(logits, axis=0)
        return (self.cal.predict(lg) if self.cal else sig(lg)), fine

    def window_logit_fn(self):
        def fn(ids, mask):
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=DEVICE == "cuda"):
                return self.model(ids, mask)["a"].float()
        return fn, self.tok

    def prob_from_logit(self, lg):
        return self.cal.predict(np.asarray(lg)) if self.cal else sig(lg)


class LegacyScorer:
    """CANDIDATE_MODEL_V2 / BEST_BASELINE through the V1 Detector loader."""

    def __init__(self, path: Path):
        from turniting_train.detector import Detector

        self.det = Detector(path)
        self.kind = self.det.kind
        self.threshold = self.det.threshold
        self.thresholds = {k: v["threshold"] for k, v in self.det.thresholds.items() if isinstance(v, dict) and "threshold" in v}
        self.cal = getattr(self.det, "calibrator", None)

    def doc_probs(self, texts):
        bs = 64 if self.kind == "transformer" else 32
        return np.asarray(self.det.machine_probability(texts, batch_size=bs)), None

    def window_logit_fn(self):
        if self.kind != "transformer":
            return None, None
        model = self.det.model

        def fn(ids, mask):
            with torch.autocast("cuda", enabled=DEVICE == "cuda"):
                out = model(input_ids=ids, attention_mask=mask).logits.float()
            return out[:, 1] - out[:, 0]
        return fn, self.det.tokenizer

    def prob_from_logit(self, lg):
        return self.cal.predict(np.asarray(lg)) if self.cal is not None else sig(lg)


def load_scorer(path: Path):
    return V3Scorer(path) if (path / "heads.pt").exists() else LegacyScorer(path)


# ------------------------------------------------------------------ windows with char offsets (stability / segments)

@torch.inference_mode()
def char_windows(fn, tok, text: str, max_length=512, stride=128, max_windows=16):
    enc = tok(text, add_special_tokens=False, return_offsets_mapping=True, truncation=False)
    ids, offs = enc["input_ids"], enc["offset_mapping"]
    content = max_length - 2
    step = content - stride
    wins, spans, start = [], [], 0
    while True:
        end = min(start + content, len(ids))
        wins.append([tok.cls_token_id] + ids[start:end] + [tok.sep_token_id])
        spans.append((offs[start][0] if start < len(offs) else 0, offs[end - 1][1] if end else 0))
        if end >= len(ids) or len(wins) >= max_windows:
            break
        start += step
    longest = max(len(w) for w in wins)
    t = torch.full((len(wins), longest), tok.pad_token_id, dtype=torch.long)
    m = torch.zeros_like(t)
    for i, w in enumerate(wins):
        t[i, : len(w)] = torch.tensor(w)
        m[i, : len(w)] = 1
    lg = fn(t.to(DEVICE), m.to(DEVICE)).cpu().numpy()
    return list(zip(spans, lg))


def segments(text: str) -> list[tuple[int, int, str]]:
    out, pos = [], 0
    parts = re.split(r"(\n\s*\n)", text)
    for p in parts:
        if p.strip() and not re.fullmatch(r"\n\s*\n", p):
            out.append((pos, pos + len(p), p.strip()))
        pos += len(p)
    if len(out) <= 1:  # no paragraphs: groups of 3 sentences
        out, pos = [], 0
        sents = re.split(r"(?<=[.!?])\s+", text)
        buf, b0 = [], 0
        for s in sents:
            i = text.find(s, pos)
            if not buf:
                b0 = i
            buf.append(s)
            pos = i + len(s)
            if len(buf) == 3:
                out.append((b0, pos, " ".join(buf).strip()))
                buf = []
        if buf:
            out.append((b0, pos, " ".join(buf).strip()))
    return out


def seg_scores(wins, segs):
    res = []
    for s0, s1, _ in segs:
        num, den = 0.0, 0.0
        for (w0, w1), lg in wins:
            ov = max(0, min(s1, w1) - max(s0, w0))
            if ov > 0:
                num += ov * float(lg)
                den += ov
        res.append(num / den if den else np.nan)
    return np.array(res)


# ------------------------------------------------------------------ metrics

def full_metrics(y, p, thr) -> dict:
    m = binary_metrics(y, p, thr)
    if len(y) and len(set(y)) >= 1:
        m["ece"] = ece_score(y, p)[0]
        m["brier"] = brier(y, p)
    return m


def span_metrics(scorer, frame) -> dict:
    """Token-level AI-span detection (V3 head C) on documents with exact char spans."""
    if not isinstance(scorer, V3Scorer):
        return {"supported": False}
    tp = fp = fn_ = tn = 0
    all_y, all_p = [], []
    for r in frame.itertuples(index=False):
        text = r.text_original
        spans = json.loads(r.span_labels) if r.span_labels else []
        enc = scorer.tok(text, add_special_tokens=False, return_offsets_mapping=True, truncation=False)
        offs = enc["offset_mapping"]
        mask = np.zeros(len(text) + 1, np.int32)
        for s, e, *_ in spans:
            mask[s:e] = 1
        cum = np.concatenate([[0], np.cumsum(mask)])
        y = np.array([1 if cum[min(e, len(text))] - cum[min(s, len(text))] > 0 else 0 for s, e in offs])
        sc = score_texts(scorer.model, scorer.tok, [text], 512, 128, None, batch_size=64, device=DEVICE, token_probs=True)[0]
        prob = np.zeros(len(offs))
        cnt = np.zeros(len(offs))
        step = 510 - 128
        for k, c in enumerate(sc["c"]):
            s0 = k * step
            prob[s0:s0 + len(c)] += c
            cnt[s0:s0 + len(c)] += 1
        prob = prob / np.maximum(cnt, 1)
        pred = prob >= 0.5
        tp += int((pred & (y == 1)).sum()); fp += int((pred & (y == 0)).sum())
        fn_ += int((~pred & (y == 1)).sum()); tn += int((~pred & (y == 0)).sum())
        all_y.append(y); all_p.append(prob)
    from sklearn.metrics import roc_auc_score

    yy, pp = np.concatenate(all_y), np.concatenate(all_p)
    prec = tp / max(tp + fp, 1)
    rec = tp / max(tp + fn_, 1)
    return {"supported": True, "docs": int(len(frame)), "tokens": int(len(yy)), "token_precision": prec, "token_recall": rec,
            "token_f1": 2 * prec * rec / max(prec + rec, 1e-9), "token_roc_auc": float(roc_auc_score(yy, pp)) if len(set(yy)) > 1 else None,
            "token_fpr": fp / max(fp + tn, 1)}


def stability(scorer, pairs: pd.DataFrame, limit: int) -> dict:
    fn, tok = scorer.window_logit_fn()
    rows = []
    pairs = pairs.groupby("kind", group_keys=False).apply(lambda g: g.head(limit))
    for r in pairs.itertuples(index=False):
        a_txt, b_txt = r.a_text, r.b_text
        if isinstance(scorer, V3Scorer) and scorer.icfg["view"] != "raw":
            a_txt, b_txt = canonicalize(a_txt), canonicalize(b_txt)
        pa_, _ = scorer.doc_probs([a_txt])
        pb_, _ = scorer.doc_probs([b_txt])
        rec = {"kind": r.kind, "global_a": float(pa_[0]), "global_b": float(pb_[0])}
        if fn is not None:
            sa, sb = segments(a_txt), segments(b_txt)
            la = seg_scores(char_windows(fn, tok, a_txt), sa)
            lb = seg_scores(char_windows(fn, tok, b_txt), sb)
            pa_seg = dict(zip([s[2] for s in sa], scorer.prob_from_logit(np.nan_to_num(la))))
            pb_seg = {s[2]: (s[0], s[1], p) for s, p in zip(sb, scorer.prob_from_logit(np.nan_to_num(lb)))}
            unchanged = [abs(pb_seg[t][2] - pa_seg[t]) for t in pb_seg if t in pa_seg]
            ai_spans = json.loads(r.b_spans) if isinstance(r.b_spans, str) and r.b_spans else []
            changed = []
            for t, (s0, s1, p) in pb_seg.items():
                if t in pa_seg:
                    continue
                if r.kind == "human_minor_edit" or any(max(0, min(s1, e) - max(s0, s)) > 0 for s, e, *_ in ai_spans):
                    changed.append(p)
            rec.update(unchanged_drift=float(np.mean(unchanged)) if unchanged else None, n_unchanged=len(unchanged),
                       changed_score_b=float(np.mean(changed)) if changed else None, n_changed=len(changed))
        rows.append(rec)
    df = pd.DataFrame(rows)
    out = {}
    for kind, g in df.groupby("kind"):
        d = {"pairs": int(len(g)), "mean_abs_global_delta": float((g["global_b"] - g["global_a"]).abs().mean()),
             "mean_global_delta": float((g["global_b"] - g["global_a"]).mean())}
        if "unchanged_drift" in g:
            d["mean_unchanged_segment_drift"] = float(g["unchanged_drift"].dropna().mean()) if g["unchanged_drift"].notna().any() else None
            d["mean_changed_segment_score"] = float(g["changed_score_b"].dropna().mean()) if g["changed_score_b"].notna().any() else None
            d["changed_segments_flagged_rate"] = float((g["changed_score_b"].dropna() >= scorer.threshold).mean()) if g["changed_score_b"].notna().any() else None
        out[kind] = d
    if "unchanged_drift" in df:
        out["overall_unchanged_segment_drift"] = float(df["unchanged_drift"].dropna().mean()) if df["unchanged_drift"].notna().any() else None
    return out


# ------------------------------------------------------------------ main

def load_texts(work: Path, ev: pd.DataFrame) -> pd.DataFrame:
    frames = []
    for split, g in ev.groupby("split"):
        ds = pads.dataset(str(work / "master_v2" / split), format="parquet")
        cols = ["id", "text_original", "fine_label", "language", "domain", "dataset", "attack", "generator_family", "span_labels"]
        frames.append(ds.to_table(columns=cols, filter=pc.field("id").isin(g["id"].unique().tolist())).to_pandas())
    return pd.concat(frames, ignore_index=True).drop_duplicates("id").set_index("id")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/content/v3work")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", action="append", required=True, help="NAME=path")
    ap.add_argument("--stability-limit", type=int, default=400)
    ap.add_argument("--span-docs", type=int, default=600)
    ap.add_argument("--limit-per-set", type=int, help="smoke tests only")
    args = ap.parse_args()
    work, out = Path(args.work), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ev = pd.read_parquet(work / "eval_sets_v2.parquet")
    if args.limit_per_set:
        ev = ev.groupby("eval_set", group_keys=False).apply(lambda x: x.head(args.limit_per_set))
    pool = load_texts(work, ev)
    log(f"evaluation pool: {len(pool):,} docs in {ev['eval_set'].nunique()} sets")
    synth = pd.read_parquet(work / "synthetic_attacks.parquet")
    if args.limit_per_set:
        synth = synth[synth["source_row"].isin(pool.index)].groupby("eval_set", group_keys=False).apply(lambda x: x.head(args.limit_per_set))
    ext = pd.read_parquet(work / "external_holdout_2026.parquet") if (work / "external_holdout_2026.parquet").exists() else None
    pairs = pd.read_parquet(work / "version_stability_pairs.parquet")
    if args.limit_per_set:
        pairs = pairs.groupby("kind", group_keys=False).apply(lambda x: x.head(5))
        ext = ext.head(args.limit_per_set) if ext is not None else None
    results = {"evaluatedAt": utc_now(), "positive_class": "MACHINE_SIGNAL", "models": {}}
    for spec in args.model:
        name, path = spec.split("=", 1)
        path = Path(path)
        if not path.exists():
            results["models"][name] = {"status": "MISSING", "path": str(path)}
            log(f"{name}: missing {path}")
            continue
        t0 = time.time()
        sc = load_scorer(path)
        texts = pool["text_original"].tolist()
        p, fine = sc.doc_probs(texts)
        scores = pd.Series(p, index=pool.index)
        y_all = (pool["fine_label"] != A.HUMAN).astype(int)
        res = {"path": str(path), "threshold": sc.threshold, "thresholds": sc.thresholds, "sets": {}}
        for set_name, g in ev.groupby("eval_set"):
            ids = g["id"].unique()
            res["sets"][set_name] = full_metrics(y_all.loc[ids].values, scores.loc[ids].values, sc.threshold)
            sub = pool.loc[ids]
            if set_name in ("test_v2", "v1_test"):
                res["sets"][set_name]["by_dataset"] = {
                    str(d): full_metrics(y_all.loc[x.index].values, scores.loc[x.index].values, sc.threshold)
                    for d, x in sub.groupby("dataset") if len(x) >= 30}
            if set_name in ("test_v2_adversarial", "v1_adversarial"):
                res["sets"][set_name]["by_attack"] = {
                    str(a): full_metrics(y_all.loc[x.index].values, scores.loc[x.index].values, sc.threshold)
                    for a, x in sub.groupby("attack") if len(x) >= 20}
            if set_name == "test_v2_unseen_generator":
                res["sets"][set_name]["by_family"] = {
                    str(a): full_metrics(y_all.loc[x.index].values, scores.loc[x.index].values, sc.threshold)
                    for a, x in sub.groupby("generator_family") if len(x) >= 20}
        if fine is not None:
            tid = ev.loc[ev["eval_set"] == "test_v2", "id"].unique()
            pos = pool.index.get_indexer(tid)
            from turniting_train.v3model import FINE_TO_B
            yb = pool.loc[tid, "fine_label"].map(FINE_TO_B).values
            pred = fine[pos].argmax(1)
            from sklearn.metrics import f1_score
            res["sets"]["test_v2"]["fine_head_macro_f1"] = float(f1_score(yb, pred, average="macro"))
        # synthetic attacks (+ the same rows clean)
        for att, g in synth.groupby("eval_set"):
            pa, _ = sc.doc_probs(g["text"].tolist())
            clean = scores.reindex(g["source_row"]).values
            yy = g["binary_label"].values
            res["sets"][att] = full_metrics(yy, pa, sc.threshold)
            res["sets"][att]["clean_same_rows"] = full_metrics(yy, clean, sc.threshold) if not np.isnan(clean).any() else None
        if ext is not None:
            main_ext = ext[~ext["negative_control"]]
            pe, _ = sc.doc_probs(main_ext["text"].tolist())
            res["sets"]["external_holdout_2026"] = full_metrics(main_ext["binary_label"].values, pe, sc.threshold)
            res["sets"]["external_holdout_2026"]["by_generator"] = {
                str(gname): {"n": int(len(x)), "recall": float((pe[x.index.map(main_ext.index.get_loc)] >= sc.threshold).mean())}
                for gname, x in main_ext[main_ext["binary_label"] == 1].groupby("generator")}
        # spans + stability
        sp_ids = ev.loc[ev["eval_set"] == "test_v2_spans", "id"].unique()[: args.span_docs]
        res["span_detection"] = span_metrics(sc, pool.loc[sp_ids].reset_index())
        res["version_stability"] = stability(sc, pairs, args.stability_limit) if sc.kind != "baseline" else {"supported": "document level only"}
        res["seconds"] = round(time.time() - t0, 1)
        results["models"][name] = res
        log(f"{name}: test_v2 macroF1={res['sets'].get('test_v2', {}).get('macro_f1')} ({res['seconds']}s)")
        write_json(out / "v3_evaluation.json", results)
        del sc
        torch.cuda.empty_cache()
    write_json(out / "v3_evaluation.json", results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
