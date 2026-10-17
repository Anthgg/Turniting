"""Paragraph-local analysis: document aggregation + paragraph mode (VALIDATION) and version
stability (TEST pairs, reported once).

    python ai-service/scripts/f005_paragraphs.py --phase select --model-path data/models/candidate-v3 \
        --v1-dir ../Turniting-training/training [--v2-dir data/v2]
    python ai-service/scripts/f005_paragraphs.py --phase stability --model-path ... [--v2-dir data/v2]

V1 texts carry no paragraph breaks, so validation/test documents are paragraphized
deterministically (groups of 3 sentences) — documented as synthetic paragraph structure.
Stability compares, for paragraphs whose text is UNCHANGED between two versions:
  WINDOW_DOCUMENT       paragraph score = mean of the 512-token document windows covering it
                        (the behaviour measured in the V3 training report)
  STRICT_PARAGRAPH      paragraph tokens only
  CONTEXTUAL_PARAGRAPH  paragraph + 64 tokens of neighbour context
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f005_common import (  # noqa: E402
    PROFILE_DIR,
    REPORT_DIR,
    binary_metrics,
    load_backend,
    log,
    stratified,
    write_json,
)

from app.services.analyzer.calibration import Calibrator  # noqa: E402
from app.services.analyzer.comparison import align_paragraphs  # noqa: E402
from app.services.analyzer.paragraphs import split_paragraphs  # noqa: E402
from app.services.analyzer.scoring import (  # noqa: E402
    AGGREGATIONS,
    CONTEXTUAL,
    STRICT,
    aggregate_document,
    score_document,
    score_paragraphs,
)

MODEL = "CANDIDATE_MODEL_V3"
SENT = re.compile(r"(?<=[.!?])\s+")
MIN = dict(min_chars=120, min_words=20, min_tokens=32)


def paragraphize(text: str, per: int = 3) -> str:
    if "\n\n" in text:
        return text
    sents = [s for s in SENT.split(" ".join(text.split())) if s]
    return "\n\n".join(" ".join(sents[i:i + per]) for i in range(0, len(sents), per))


def load_docs(v1_dir: Path, split_sets: list[str], cap: int, role: str, seed: int = 42) -> pd.DataFrame:
    master = v1_dir / "datasets" / "normalized" / "master"
    cols = ["id", "text", "label", "language", "domain", "dataset"]
    if role == "validation":
        df = pads.dataset(str(master / "validation"), format="parquet").to_table(columns=cols).to_pandas()
    else:
        ev = pd.read_parquet(v1_dir / "datasets" / "manifests" / "eval_sets.parquet")
        ev = ev[ev["eval_set"].isin(split_sets)]
        parts = [pads.dataset(str(master / s), format="parquet").to_table(
            columns=cols, filter=pc.field("id").isin(g["id"].tolist())).to_pandas() for s, g in ev.groupby("split")]
        df = pd.concat(parts)
    df = df[df["label"].notna() & (df["text"].str.split().str.len() >= 150)]
    df["is_es"] = df["language"] == "es"
    df = stratified(df, cap, ["label", "is_es"], seed)
    df["text"] = df["text"].map(paragraphize)
    return df.reset_index(drop=True)


def window_paragraph_scores(backend, profiles, icfg, text: str, paras) -> list[float | None]:
    doc = score_document(backend, text, profiles, icfg.get("aggregation", "mean"))
    out = []
    for p in paras:
        num = den = 0.0
        for w in doc.windows:
            ov = max(0, min(p.char_end, w["charEnd"]) - max(p.char_start, w["charStart"]))
            num += ov * w["logit"]
            den += ov
        out.append(num / den if den else None)
    return out


def paragraph_logits(backend, profiles, icfg, text: str, mode: str):
    paras = split_paragraphs(text)
    if mode == "WINDOW_DOCUMENT":
        return paras, window_paragraph_scores(backend, profiles, icfg, text, paras)
    res = score_paragraphs(backend, paras, profiles, mode, 384, 64, **MIN)
    return paras, [r.logit for r in res]


def select(args, backend, icfg, profiles, cal: Calibrator, prof: dict) -> None:
    docs = load_docs(args.v1_dir, [], args.cap, "validation")
    t_low = prof["thresholds"]["LOW_FALSE_POSITIVE"]
    rows, drift_rows = [], []
    rng = random.Random(42)
    for mode in (STRICT, CONTEXTUAL):
        agg_scores = {a: [] for a in AGGREGATIONS}
        drifts = []
        for k, r in enumerate(docs.itertuples(index=False)):
            paras, logits = paragraph_logits(backend, profiles, icfg, r.text, mode)
            ok = [(p, lg) for p, lg in zip(paras, logits) if lg is not None]
            probs = [float(cal.predict([lg])[0]) for _, lg in ok]
            toks = [max(1, p.words) for p, _ in ok]
            for a in AGGREGATIONS:
                agg_scores[a].append(aggregate_document(probs, toks, a, t_low))
            if k < args.cap // 3 and len(paras) >= 4:  # synthetic local edit -> drift of untouched paragraphs
                j = rng.randrange(len(paras))
                words = paras[j].text.split()
                for _ in range(max(1, len(words) // 20)):
                    i = rng.randrange(max(1, len(words) - 1))
                    words[i:i + 2] = words[i:i + 2][::-1]
                edited = r.text[:paras[j].char_start] + " ".join(words) + r.text[paras[j].char_end:]
                pb, lb = paragraph_logits(backend, profiles, icfg, edited, mode)
                for al in align_paragraphs(paras, pb):
                    if al.status == "UNCHANGED" and logits[al.base_index] is not None and lb[al.target_index] is not None:
                        drifts.append(abs(float(cal.predict([lb[al.target_index]])[0] - cal.predict([logits[al.base_index]])[0])))
        y = docs["label"].to_numpy().astype(int)
        for a, vals in agg_scores.items():
            v = np.array([np.nan if x is None else x for x in vals], dtype=float)
            ok = ~np.isnan(v)
            m = binary_metrics(y[ok], v[ok], t_low)
            rows.append({"mode": mode, "aggregation": a, "macro_f1": m["macro_f1"], "fpr": m["fpr"], "recall": m["recall"],
                         "roc_auc": m.get("roc_auc"), "n": int(ok.sum())})
        d = np.array(drifts) if drifts else np.array([0.0])
        drift_rows.append({"mode": mode, "pairs_paragraphs": len(drifts), "median": float(np.median(d)),
                           "p90": float(np.percentile(d, 90)), "p95": float(np.percentile(d, 95)), "mean": float(d.mean())})
        log(f"{mode}: drift median {np.median(d):.4f} p95 {np.percentile(d, 95):.4f}")
    # choose: mode with lower validation p95 drift (tie-break macro F1), then the best aggregation in that mode
    best_mode = min(drift_rows, key=lambda r: (round(r["p95"], 3), -max(x["macro_f1"] or 0 for x in rows if x["mode"] == r["mode"])))["mode"]
    in_mode = [r for r in rows if r["mode"] == best_mode]
    best_agg = max(in_mode, key=lambda r: ((r["macro_f1"] or 0) - 2 * max(0.0, (r["fpr"] or 0) - 0.05)))
    prof_path = PROFILE_DIR / f"{MODEL}.json"
    prof = json.loads(prof_path.read_text(encoding="utf-8"))
    prof.update(documentAggregation=best_agg["aggregation"], paragraphMode=best_mode,
                aggregationSelectedOn="VALIDATION (synthetic paragraph structure, LOW_FALSE_POSITIVE threshold)")
    write_json(prof_path, prof)
    write_json(REPORT_DIR / "paragraph_selection_validation.json", {"model": MODEL, "documents": int(len(docs)),
               "aggregation": rows, "drift": drift_rows, "selected": {"paragraphMode": best_mode,
               "documentAggregation": best_agg["aggregation"]}, "threshold": t_low})
    log(f"selected paragraph mode {best_mode}, aggregation {best_agg['aggregation']}")


def stability(args, backend, icfg, profiles, cal: Calibrator) -> None:
    pairs = []
    if args.v2_dir and (args.v2_dir / "version_stability_pairs.parquet").exists():
        vp = pd.read_parquet(args.v2_dir / "version_stability_pairs.parquet")
        vp = vp.groupby("kind", group_keys=False).apply(lambda g: g.sample(min(len(g), args.cap // 3), random_state=42))
        pairs += [(r.kind, r.a_text, r.b_text) for r in vp.itertuples(index=False)]
    docs = load_docs(args.v1_dir, ["test", "test_spanish", "test_academic"], args.cap, "test", seed=7)
    rng = random.Random(7)
    donors = docs.sample(frac=1.0, random_state=3)["text"].tolist()
    for i, r in enumerate(docs.itertuples(index=False)):
        paras = split_paragraphs(r.text)
        if len(paras) < 4:
            continue
        j = rng.randrange(len(paras))
        if i % 2 == 0:
            words = paras[j].text.split()
            for _ in range(max(1, len(words) // 20)):
                k = rng.randrange(max(1, len(words) - 1))
                words[k:k + 2] = words[k:k + 2][::-1]
            new, kind = " ".join(words), "synthetic_minor_edit"
        else:
            donor = split_paragraphs(donors[i % len(donors)])
            new, kind = (donor[0].text if donor else paras[j].text), "synthetic_paragraph_replacement"
        pairs.append((kind, r.text, r.text[:paras[j].char_start] + new + r.text[paras[j].char_end:]))
    out = {}
    for mode in ("WINDOW_DOCUMENT", STRICT, CONTEXTUAL):
        drift, by_kind = [], {}
        for kind, a, b in pairs:
            pa, la = paragraph_logits(backend, profiles, icfg, a, mode)
            pb, lb = paragraph_logits(backend, profiles, icfg, b, mode)
            for al in align_paragraphs(pa, pb):
                if al.status == "UNCHANGED" and la[al.base_index] is not None and lb[al.target_index] is not None:
                    d = abs(float(cal.predict([lb[al.target_index]])[0] - cal.predict([la[al.base_index]])[0]))
                    drift.append(d)
                    by_kind.setdefault(kind, []).append(d)
        d = np.array(drift) if drift else np.array([np.nan])
        out[mode] = {"unchanged_paragraphs": len(drift), "median": float(np.nanmedian(d)), "p90": float(np.nanpercentile(d, 90)),
                     "p95": float(np.nanpercentile(d, 95)), "mean": float(np.nanmean(d)),
                     "by_kind": {k: {"n": len(v), "median": float(np.median(v)), "p95": float(np.percentile(v, 95))}
                                 for k, v in by_kind.items()}}
        log(f"{mode}: unchanged drift median {out[mode]['median']:.4f} p95 {out[mode]['p95']:.4f}")
    write_json(REPORT_DIR / "paragraph_stability.json", {"model": MODEL, "pairs": len(pairs),
               "pair_kinds": pd.Series([k for k, _, _ in pairs]).value_counts().to_dict(), "modes": out,
               "note": "TEST-side pairs, evaluated once after the paragraph mode was chosen on validation"})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=["select", "stability"], required=True)
    ap.add_argument("--model-path", required=True, type=Path)
    ap.add_argument("--v1-dir", required=True, type=Path)
    ap.add_argument("--v2-dir", type=Path)
    ap.add_argument("--cap", type=int, default=150)
    ap.add_argument("--threads", type=int, default=8)
    args = ap.parse_args()
    prof = json.loads((PROFILE_DIR / f"{MODEL}.json").read_text(encoding="utf-8"))
    cal = Calibrator.from_dict(prof["calibration"])
    backend, icfg, profiles = load_backend(MODEL, args.model_path, "cpu", args.threads)
    (select if args.phase == "select" else stability)(args, backend, icfg, profiles, cal, *([prof] if args.phase == "select" else []))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
