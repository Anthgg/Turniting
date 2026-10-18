"""F006.1 step 1: Spanish error audit (diagnosis before any training).

    python scripts/f006_1_audit.py

Why was F006 Spanish human FPR 0.014 on F006 VALIDATION but 0.142 on the F006 FINAL HOLDOUT?

* decisions use TRAIN + VALIDATION only; the observed F006 holdout is described afterwards (composition and,
  clearly labelled DESCRIPTIVE_ONLY, its per-source error rates) and never feeds a parameter;
* compares Spanish humans of TRAIN (scored sample), F006 VALIDATION and F006 HOLDOUT by source dataset, origin
  (V1 / V2), original V1 split, domain, length, style features (sentence length, paragraphs, punctuation,
  citations, references, digits, uppercase, non-ASCII / unusual Unicode, type-token ratio, lexical density);
* scores TRAIN and VALIDATION Spanish humans with CANDIDATE_MODEL_V3 and EXPERIMENTAL_F006_MODEL (calibrated, at
  their locked BALANCED thresholds) -> reused by hard mining and the V3-vs-F006 disagreement report.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import categorical_to_str, log, wilson, write_json  # noqa: E402

D6 = Path("/content/drive/MyDrive/turniting/f006")
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
V3D = Path("/content/drive/MyDrive/turniting/v3")
STOP_ES = set("""de la que el en y a los se del las un por con no una su para es al lo como más o pero sus le ha me si sin sobre
este ya entre cuando todo esta ser son dos también fue había era muy años hasta desde está mi porque qué sólo han yo hay vez
puede todos así nos ni parte tiene él uno donde bien tiempo mismo ese ahora cada e vida otro después te otros aunque esa eso
hace otra gobierno tan durante siempre día tanto ella tres sí dijo sido gran país según menos mundo año antes estado""".split())
CIT = re.compile(r"\(([A-ZÁÉÍÓÚ][\w\-]+(?: et al\.)?,? (?:19|20)\d{2}[a-z]?)\)|\[\d+(?:[,–-]\d+)*\]")
REF = re.compile(r"\b(referencias|bibliograf[ií]a|doi:|https?://)", re.I)
SENT = re.compile(r"[.!?¿¡]+")
WORD = re.compile(r"\w+", re.U)


def style(text: str) -> dict:
    t = text[:6000]
    words = WORD.findall(t.lower())
    n = max(len(words), 1)
    sents = [s for s in SENT.split(t) if s.strip()]
    paras = [p for p in re.split(r"\n\s*\n", t) if p.strip()]
    nonascii = sum(1 for c in t if ord(c) > 127)
    unusual = sum(1 for c in t if ord(c) > 127 and unicodedata.category(c)[0] in "CZS" and c not in "¿¡«»—–“”‘’€°ºª·")
    return {"words": len(text.split()), "mean_sentence_words": n / max(len(sents), 1), "paragraphs": len(paras),
            "newline_rate": t.count("\n") / max(len(t), 1) * 100, "comma_rate": t.count(",") / n,
            "semicolon_colon_rate": (t.count(";") + t.count(":")) / n, "quote_rate": sum(t.count(q) for q in "\"«»“”") / n,
            "inverted_marks": (t.count("¿") + t.count("¡")) / n, "digit_rate": sum(ch.isdigit() for ch in t) / max(len(t), 1),
            "upper_rate": sum(ch.isupper() for ch in t) / max(len(t), 1), "citations": len(CIT.findall(t)), "references_or_urls": len(REF.findall(t)),
            "non_ascii_rate": nonascii / max(len(t), 1), "unusual_unicode": unusual, "type_token_ratio": len(set(words[:400])) / max(min(n, 400), 1),
            "lexical_density": 1 - sum(w in STOP_ES for w in words) / n}


def describe(frame: pd.DataFrame, name: str, feats: pd.DataFrame | None) -> dict:
    out = {"name": name, "n": int(len(frame)),
           "by_dataset": frame["dataset"].value_counts().to_dict(),
           "by_origin": frame["origin"].value_counts().to_dict() if "origin" in frame else None,
           "by_v1_split": frame["v1_split"].fillna("none").value_counts().to_dict() if "v1_split" in frame else None,
           "by_domain": frame["domain"].value_counts().to_dict(),
           "length_quantiles_words": {str(q): float(frame["n_words"].quantile(q)) for q in (0.1, 0.25, 0.5, 0.75, 0.9)}}
    if feats is not None and len(feats):
        out["style_medians"] = feats.median(numeric_only=True).round(4).to_dict()
        out["style_means"] = feats.mean(numeric_only=True).round(4).to_dict()
    return out


def model_probs(model_dir: Path, cal_dict: dict, texts: list[str]) -> np.ndarray:
    import torch
    from transformers import AutoTokenizer

    from f006_score import doc_logits
    from turniting_train.calibration import Calibrator
    from turniting_train.v3model import V3Detector

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = V3Detector.load(model_dir, dev)
    tok = AutoTokenizer.from_pretrained(model_dir / "backbone")
    icfg = json.loads((model_dir / "inference_config.json").read_text())
    lg = doc_logits(m, tok, texts, icfg.get("view", "canonical"), icfg.get("aggregation", "mean"), icfg.get("max_windows_per_doc", 8), device=dev)
    del m
    torch.cuda.empty_cache()
    return Calibrator.from_dict(cal_dict).predict(lg)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", default="/content/f006work/master_v2")
    ap.add_argument("--train-sample", type=int, default=30000)
    ap.add_argument("--repo-reports", default=str(Path(__file__).resolve().parents[1] / "reports" / "f006_1"))
    a = ap.parse_args()
    lock = json.loads((D6 / "manifests" / "F006_MODEL_LOCK.json").read_text())
    v4dir = Path(lock["modelPath"])
    v4cal = json.loads((v4dir / "calibration.json").read_text())["selected"]
    v3cal = lock["references"]["CANDIDATE_MODEL_V3"]["calibration"]
    th = {"V3": lock["references"]["CANDIDATE_MODEL_V3"]["thresholds"]["BALANCED"]["threshold"], "F006": lock["thresholds"]["BALANCED"]}
    idx = categorical_to_str(pd.read_parquet(V3D / "datasets" / "index_v2.parquet",
                                             columns=["id", "dataset", "fine_label", "domain", "language", "n_words", "origin", "v1_split", "split", "status", "group_id"]))
    idx = idx[(idx["status"] == "KEPT")]
    es_idx = idx[idx["language"] == "es"]
    log("Spanish rows by split x label: " + json.dumps({s: g["fine_label"].value_counts().to_dict() for s, g in es_idx.groupby("split")}))
    val = pd.read_parquet(D6 / "datasets" / "f006_validation.parquet")
    hold = pd.read_parquet(D6 / "datasets" / "f006_final_holdout.parquet")
    meta = idx.set_index("id")[["origin", "v1_split"]]
    for f in (val, hold):
        f[["origin", "v1_split"]] = meta.reindex(f["id"]).values
    vh = val[(val["language"] == "es") & (val["label"] == 0)].reset_index(drop=True)
    hh = hold[(hold["language"] == "es") & (hold["label"] == 0)].reset_index(drop=True)
    # TRAIN Spanish humans: stratified sample, text from master
    tr = es_idx[(es_idx["split"] == "train") & (es_idx["fine_label"] == "HUMAN")]
    trs = tr.groupby("dataset", group_keys=False).apply(lambda g: g.sample(min(len(g), max(500, int(a.train_sample * len(g) / len(tr)))), random_state=61))
    ds = pads.dataset(str(Path(a.master) / "train"), format="parquet")
    txt = ds.to_table(columns=["id", "text_original"], filter=pc.field("id").isin(trs["id"].tolist())).to_pandas()
    trs = trs.merge(txt, on="id").reset_index(drop=True)
    log(f"Spanish humans: train sample {len(trs):,} (of {len(tr):,}), F006 validation {len(vh):,}, F006 holdout {len(hh):,}")
    feats = {k: pd.DataFrame([style(t) for t in f["text_original"]]) for k, f in (("train", trs), ("validation", vh), ("holdout", hh))}
    # model scores on TRAIN + VALIDATION Spanish humans (decision side)
    for name, mdir, cal in (("F006", v4dir, v4cal), ("V3", V3D / "models" / "spanish_academic", v3cal)):
        trs[f"p_{name}"] = model_probs(mdir, cal, trs["text_original"].tolist())
        vh[f"p_{name}"] = model_probs(mdir, cal, vh["text_original"].tolist())
        log(f"{name}: scored train/validation Spanish humans")
    rep = {"question": "F006 Spanish human FPR 0.014 on F006 validation vs 0.142 on the F006 final holdout",
           "thresholds_balanced_calibrated": th,
           "spanish_rows_by_split_label": {s: g["fine_label"].value_counts().to_dict() for s, g in es_idx.groupby("split")},
           "train_spanish_humans": describe(trs, "TRAIN Spanish humans (stratified sample)", feats["train"]),
           "validation_spanish_humans": describe(vh, "F006 VALIDATION Spanish humans", feats["validation"]),
           "holdout_spanish_humans": describe(hh, "F006 HOLDOUT Spanish humans (observed; descriptive)", feats["holdout"])}
    for part, f in (("train", trs), ("validation", vh)):
        rep[f"{part}_fpr_by_dataset"] = {}
        for d, g in f.groupby("dataset"):
            r = {"n": int(len(g))}
            for mname in ("V3", "F006"):
                k = int((g[f"p_{mname}"] >= th[mname]).sum())
                r[mname] = {"fpr": k / len(g), "ci95": wilson(k, len(g))}
            rep[f"{part}_fpr_by_dataset"][d] = r
    # DESCRIPTIVE ONLY: observed holdout errors by source (already in holdout_probs.parquet from F006; nothing is selected on it)
    hp = pd.read_parquet(D6 / "reports" / "holdout_probs.parquet").set_index("id")
    hh["p_F006"] = hp.reindex(hh["id"])["F006_MODEL"].values
    hh["p_V3"] = hp.reindex(hh["id"])["CANDIDATE_MODEL_V3"].values
    desc = {}
    for keys, g in hh.groupby(["dataset", "origin", hh["v1_split"].fillna("none")]):
        r = {"n": int(len(g))}
        for mname in ("V3", "F006"):
            k = int((g[f"p_{mname}"] >= th[mname]).sum())
            r[mname] = {"fpr": k / len(g), "ci95": wilson(k, len(g))}
        desc["|".join(map(str, keys))] = r
    rep["DESCRIPTIVE_ONLY_observed_f006_holdout_fpr_by_source"] = desc
    # style shift: standardised mean difference holdout vs validation and train vs validation
    smd = {}
    for c in feats["validation"].columns:
        v, h, t = feats["validation"][c], feats["holdout"][c], feats["train"][c]
        sd = np.sqrt((v.var() + h.var()) / 2) or 1.0
        smd[c] = {"holdout_vs_validation": float((h.mean() - v.mean()) / sd), "train_vs_validation": float((t.mean() - v.mean()) / sd)}
    rep["style_standardised_mean_difference"] = smd
    # where do the validation / holdout Spanish humans come from relative to TRAIN?
    trd = set(tr["dataset"])
    rep["holdout_spanish_human_datasets_absent_from_validation"] = sorted(set(hh["dataset"]) - set(vh["dataset"]))
    rep["holdout_spanish_human_share_v1_test_split"] = float((hh["v1_split"].fillna("") != "").mean())
    rep["validation_spanish_human_share_v1_rows"] = float((vh["origin"] == "v1").mean())
    rep["datasets_with_train_humans"] = sorted(trd)
    D61.joinpath("datasets").mkdir(parents=True, exist_ok=True)
    trs.drop(columns=["text_original"]).to_parquet(D61 / "datasets" / "train_spanish_human_scores.parquet", index=False)
    vh.drop(columns=["text_original", "text_normalized", "span_labels"], errors="ignore").to_parquet(D61 / "datasets" / "f006_val_spanish_human_scores.parquet", index=False)
    write_json(D61 / "reports" / "spanish_distribution_audit.json", rep)
    write_json(Path(a.repo_reports) / "spanish_distribution_audit.json", rep)
    log("audit written")
    print(json.dumps({k: rep[k] for k in ("holdout_spanish_human_datasets_absent_from_validation", "holdout_spanish_human_share_v1_test_split",
                                         "validation_spanish_human_share_v1_rows")}, indent=1))
    print(json.dumps({"validation": rep["validation_spanish_humans"]["by_dataset"], "holdout": rep["holdout_spanish_humans"]["by_dataset"],
                      "holdout_origin": rep["holdout_spanish_humans"]["by_origin"], "holdout_v1split": rep["holdout_spanish_humans"]["by_v1_split"]}, indent=1))
    print(json.dumps(desc, indent=0)[:4000])
    print(json.dumps(rep["validation_fpr_by_dataset"], indent=0)[:2000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
