"""F006.3: dedup, language metadata, group-safe splits, MULTILINGUAL_MIXED_DOCUMENTS, leakage audit, LOCKED F006_3_FINAL_EXTERNAL_HOLDOUT.

    python scripts/f0063_splits.py

Units: OpenAlex human abstracts by WHOLE venue; open-generator rows by topic / parent (FINAL_ONLY generators only FINAL); Claude rows by
topic (never FINAL); AIGTBench by text (FINAL_ONLY generators only FINAL). Historical: F006.2 TRAIN_EXTRA is the replay base (it already
contains F006.1.1 replay + TDX controlled replay); F006.1.1 VALIDATION groups give the historical-forgetting slice of VALIDATION /
CALIBRATION; F006.2 and F006.1.1 final holdouts are REGRESSION_HOLDOUTs (observed, continuity only).
Mixed-language documents are built per side from that side's paragraphs (title / references are PRESENTATION_EXCLUDED and never labelled).
Gates: TRAIN vs every evaluation split and FINAL vs VAL / CAL: exact, near (MinHash J >= 0.8), group, parent, source, lineage = 0.
"""

from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0063_common import (D611, D62, LANGS, MANI, MASTER, MIXED, MULTI, NORM, REPO, SEED, SPLITS, detect_lang, unit, venue_side,  # noqa: E402
                          write_json)
from f0611_splits import near_dup_members  # noqa: E402
from f006_lib import log, sha256_file, sha256_ids  # noqa: E402
from f006_splits import cap  # noqa: E402
from turniting_train.textnorm import normalized_text_hash  # noqa: E402

V3D = D611.parent / "v3"
CAPS = {"VAL": 2200, "CAL": 1400, "FINAL": 1800}  # per language, humans + machines of new sources
HIST_VAL, HIST_CAL = 6000, 3000
KEEP = ["id", "primary", "label", "fine_label", "cls", "dataset", "generator", "provider", "model", "domain", "language", "paragraph_language",
        "language_confidence", "n_words", "group_id", "parent_id", "source_id", "text_hash", "hard_human", "span_labels", "text_original", "text_normalized",
        "ai_fraction", "transformation_type", "origin", "section_type", "parent_document_id", "section_id", "document_language_primary",
        "detected_languages", "mixed_language", "code_switching", "translated_section", "role"]
REF_TEMPLATES = ["{a}, {b}. ({y}). {t}. Revista de {f}, {v}({n}), {p}-{q}. https://doi.org/10.{d}/{x}",
                 "{a}, {b}. ({y}). {t}. Journal of {f}, {v}, {p}-{q}. doi:10.{d}/{x}",
                 "{a}, {b}. ({y}). {t}. Revue de {f}, {v}, {p}-{q}.",
                 "{a}, {b}. ({y}). {t}. Revista Brasileira de {f}, {v}({n}), {p}-{q}.",
                 "{a}, {b} ({y}): {t}. Zeitschrift für {f}, {v}, S. {p}-{q}."]


def load_new() -> pd.DataFrame:
    parts = []
    oa = pd.read_parquet(NORM / "openalex_academic.parquet")
    oa["side"] = oa["venue"].map(venue_side)
    oa["role"] = "HUMAN"
    parts.append(oa)
    ag = pd.read_parquet(NORM / "aigtbench.parquet")

    def ag_side(r):
        u = unit("aigt:" + r.id)
        if r.role == "FINAL_ONLY":
            return "FINAL"
        if r.label == 0:
            return "TRAIN" if u < 0.6 else "VAL" if u < 0.7 else "CAL" if u < 0.8 else "FINAL"
        return "TRAIN" if u < 0.75 else "VAL" if u < 0.9 else "CAL"
    ag["side"] = [ag_side(r) for r in ag.itertuples(index=False)]
    parts.append(ag)
    for f in sorted(MULTI.glob("open_*.parquet")):
        parts.append(pd.read_parquet(f))
    cp = NORM / "claude_multilingual.parquet"
    if cp.exists():
        cl = pd.read_parquet(cp)
        assert not (cl["side"] == "FINAL").any(), "Claude rows can never be FINAL"
        parts.append(cl)
    new = pd.concat(parts, ignore_index=True)
    excl = new["cls"] == "PRESENTATION_EXCLUDED"
    new.loc[excl, "label"] = np.nan
    for c in ("span_labels", "ai_fraction", "transformation_type", "source_id", "parent_id", "section_type", "provider", "model", "role"):
        if c not in new:
            new[c] = None
    new["text_original"], new["text_normalized"], new["origin"] = new["text"], None, "f006_3_new"
    new["text_hash"] = new["text_original"].map(normalized_text_hash)
    return new


def primary_of(r) -> str:
    if r.cls == "PRESENTATION_EXCLUDED":
        return "presentation_excluded"
    if r.dataset == "aigtbench":
        return "unseen_generator" if r.role == "FINAL_ONLY" else "ood"
    if r.dataset == "open_llm_multilingual" and r.role in ("FINAL_ONLY", "VAL_UNSEEN_PROXY"):
        return "unseen_generator"
    if r.fine_label == "MIXED":
        return "span" if isinstance(r.span_labels, str) and unit("span:" + r.id) < 0.5 else "mixed"
    if r.fine_label in ("AI_EDITED", "PARAPHRASED_AI"):
        return "ai_edited"
    return "academic"


def refs(rng: random.Random, n: int) -> list[str]:
    out = []
    for _ in range(n):
        out.append(rng.choice(REF_TEMPLATES).format(a=rng.choice(["García", "Smith", "Dubois", "Silva", "Müller", "Rossi", "Jansen"]),
                                                  b=rng.choice("ABCDEJLMR"), y=rng.randint(1998, 2020),
                                                  t=rng.choice(["Análisis de", "A study of", "Étude sur", "Estudo de", "Untersuchung zu"]) + " " +
                                                  rng.choice(["políticas públicas", "learning outcomes", "la mobilité urbaine", "saúde coletiva", "Energiesysteme"]),
                                                  f=rng.choice(["Educación", "Engineering", "Sociologie", "Saúde", "Wirtschaft"]), v=rng.randint(3, 60),
                                                  n=rng.randint(1, 6), p=rng.randint(1, 300), q=rng.randint(301, 600), d=rng.randint(1000, 9999),
                                                  x=rng.randint(10000, 99999)))
    return out


def mixed_docs(pool: pd.DataFrame, side: str, n_docs: int) -> pd.DataFrame:
    """Real-structure documents: primary-language body + abstract in another language + quotation + multilingual references.
    HUMAN docs (all sections human), MIXED docs (1-2 body sections replaced by AI text of the same side and language)."""
    rng = random.Random(f"{SEED}:mixed:{side}")
    h = pool[(pool["label"] == 0) & (pool["dataset"] == "openalex_academic")]
    m = pool[(pool["label"] == 1) & pool["cls"].isin(["AI_GENERATED", "AI_REVISED"])]
    if side == "FINAL":
        m = m[m["dataset"] != "claude_multilingual"]
    by_l = {l: h[h["language"] == l] for l in LANGS}
    ai_l = {l: m[m["language"] == l] for l in LANGS}
    rows = []
    patterns = [("es", "en", "fr"), ("es", "en", "pt"), ("pt", "en", "es"), ("fr", "en", "de"), ("de", "en", "fr"), ("en", "es", "fr")]
    for k in range(n_docs):
        prim, abs_l, quote_l = rng.choice(patterns)
        if min(len(by_l[prim]), len(by_l[abs_l]), len(by_l[quote_l])) < 5:
            continue
        doc = f"mixdoc:{side}:{k:05d}"
        make_ai = rng.random() < 0.5 and len(ai_l[prim]) > 3
        secs = [("RESUMEN", prim, by_l[prim].sample(1, random_state=rng.randint(0, 10**9)).iloc[0]),
                ("ABSTRACT", abs_l, by_l[abs_l].sample(1, random_state=rng.randint(0, 10**9)).iloc[0])]
        body = by_l[prim].sample(3, random_state=rng.randint(0, 10**9))
        for j, (_, b) in enumerate(body.iterrows()):
            if make_ai and j in (1, 2) and rng.random() < 0.7:
                b = ai_l[prim].sample(1, random_state=rng.randint(0, 10**9)).iloc[0]
            secs.append((["INTRODUCTION", "DISCUSSION", "CONCLUSION"][j], prim, b))
        q = by_l[quote_l].sample(1, random_state=rng.randint(0, 10**9)).iloc[0]
        qs = q["text"].split(". ")[0][:400]
        detected = sorted({s[1] for s in secs} | {quote_l})
        for j, (typ, l, r) in enumerate(secs):
            rows.append({**{c: r.get(c) for c in r.index}, "parent_document_id": doc, "section_id": f"{doc}#s{j}", "section_type": typ,
                         "document_language_primary": prim, "detected_languages": json.dumps(detected), "mixed_language": True,
                         "code_switching": False, "translated_section": False, "doc_label": "MIXED" if make_ai else "HUMAN"})
        rows.append({"id": f"{doc}#quote", "text": qs, "text_original": qs, "label": 0, "fine_label": "HUMAN", "cls": "HUMAN", "dataset": "mixed_quote",
                     "language": quote_l, "domain": "academic", "parent_document_id": doc, "section_id": f"{doc}#q", "section_type": "QUOTATION",
                     "document_language_primary": prim, "detected_languages": json.dumps(detected), "mixed_language": True, "code_switching": True,
                     "translated_section": False, "group_id": q["group_id"], "parent_id": q["parent_id"], "doc_label": "MIXED" if make_ai else "HUMAN"})
        for j, ref in enumerate(refs(rng, rng.randint(3, 6))):
            rows.append({"id": f"{doc}#ref{j}", "text": ref, "text_original": ref, "label": np.nan, "fine_label": None, "cls": "PRESENTATION_EXCLUDED",
                         "dataset": "mixed_references", "language": "multi", "domain": "references", "parent_document_id": doc, "section_id": f"{doc}#r{j}",
                         "section_type": "REFERENCES", "document_language_primary": prim, "detected_languages": json.dumps(detected),
                         "mixed_language": True, "code_switching": False, "translated_section": False, "group_id": doc, "parent_id": doc,
                         "doc_label": "MIXED" if make_ai else "HUMAN"})
    return pd.DataFrame(rows)


def main() -> int:
    mp = MANI / "f006_3_final_external_holdout.json"
    if mp.exists() and json.loads(mp.read_text()).get("LOCKED"):
        assert sha256_file(SPLITS / "f006_3_final_external_holdout.parquet") == json.loads(mp.read_text())["holdout_file_sha256"]
        log("F006_3_FINAL_EXTERNAL_HOLDOUT already LOCKED; verified")
        return 0
    for p in (SPLITS, MIXED):
        p.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    new = load_new()
    n0 = len(new)
    new = new.drop_duplicates("text_hash")
    exact_within = n0 - len(new)
    idx = pd.read_parquet(V3D / "datasets" / "index_v2.parquet", columns=["id", "text_hash", "split", "group_id"])
    ex62 = pd.read_parquet(D62 / "datasets" / "splits" / "f006_2_train_extra.parquet", columns=["id", "text_original", "group_id", "dataset", "language", "domain"])
    ex62["text_hash"] = ex62["text_original"].map(normalized_text_hash)
    hist_eval = []
    for p in (D611 / "datasets" / "f006_1_1_validation.parquet", D611 / "datasets" / "f006_1_1_final_holdout.parquet",
              D62 / "datasets" / "splits" / "f006_2_validation.parquet", D62 / "datasets" / "splits" / "f006_2_calibration.parquet",
              D62 / "datasets" / "splits" / "f006_2_final_external_holdout.parquet"):
        hist_eval.append(pd.read_parquet(p, columns=["id", "text_original", "group_id"]))
    hist_eval = pd.concat(hist_eval, ignore_index=True)
    hist_eval["text_hash"] = hist_eval["text_original"].map(normalized_text_hash)
    hist_hash = set(idx["text_hash"].dropna()) | set(ex62["text_hash"]) | set(hist_eval["text_hash"])
    exh = new["text_hash"].isin(hist_hash)
    new = new[~exh].reset_index(drop=True)
    ref = []
    for split in sorted(p.name for p in MASTER.iterdir() if p.is_dir()):
        ds_ = pads.dataset(str(MASTER / split), format="parquet")
        ref.append(ds_.to_table(columns=["text_original"], filter=(pc.field("domain") == "academic") | pc.field("language").isin(["es", "pt", "fr", "de"])).to_pandas())
    ref.append(ex62.loc[(ex62["domain"] == "academic") | ex62["language"].isin(["es", "pt", "fr", "de"]), ["text_original"]])
    ref = pd.concat(ref + [hist_eval[["text_original"]]], ignore_index=True)
    hum = new[new["label"] == 0].copy()
    near = near_dup_members(ref, hum)
    near_ids = set(hum.iloc[sorted(near)]["id"]) if near else set()
    new = new[~new["id"].isin(near_ids)].reset_index(drop=True)
    del ref
    dedup = {"rows_before": int(n0), "exact_within_new_removed": int(exact_within), "exact_vs_historical_removed": int(exh.sum()),
             "near_vs_historical_removed": len(near_ids), "rows_after": int(len(new))}
    log("dedup " + json.dumps(dedup))
    lid = [detect_lang(t) for t in new["text_original"]]
    new["paragraph_language"], new["language_confidence"] = [x[0] for x in lid], [x[1] for x in lid]
    new["document_language_primary"], new["detected_languages"] = new["language"], new["language"].map(lambda l: json.dumps([l]))
    new["mixed_language"], new["code_switching"], new["translated_section"] = False, False, False
    new["parent_document_id"] = new["parent_id"]
    new["section_id"] = new["id"]
    new["primary"] = [primary_of(r) for r in new.itertuples(index=False)]
    new["hard_human"] = False
    sides = {s: new[new["side"] == s].copy() for s in ("TRAIN", "VAL", "CAL", "FINAL")}
    hist_train_g = set(idx.loc[idx["split"] == "train", "group_id"]) | set(ex62["group_id"])
    for s in ("VAL", "CAL", "FINAL"):  # an evaluation group that ever appeared in a historical TRAIN is dropped (never moved)
        sides[s] = sides[s][~sides[s]["group_id"].isin(hist_train_g)]
    eval_g = set().union(*(set(sides[s]["group_id"]) for s in ("VAL", "CAL", "FINAL")))
    dedup["train_rows_dropped_group_overlap"] = int(sides["TRAIN"]["group_id"].isin(eval_g).sum())
    sides["TRAIN"] = sides["TRAIN"][~sides["TRAIN"]["group_id"].isin(eval_g)]
    rng = random.Random(SEED)
    for s in ("VAL", "CAL", "FINAL"):
        f = sides[s]
        keep = []
        for l in sorted(f["language"].dropna().unique()):
            g = f[f["language"] == l]
            if len(g) > CAPS[s]:
                grp = g["group_id"].drop_duplicates().sample(frac=1.0, random_state=rng.randint(0, 10**6))
                sizes = g.groupby("group_id").size()
                chosen, tot = set(), 0
                for x in grp:
                    if tot >= CAPS[s]:
                        break
                    chosen.add(x)
                    tot += int(sizes[x])
                g = g[g["group_id"].isin(chosen)]
            keep.append(g)
        sides[s] = pd.concat(keep, ignore_index=True)
    assert not (sides["FINAL"]["dataset"] == "claude_multilingual").any()
    md = {s: mixed_docs(sides[s], s, {"VAL": 300, "CAL": 120, "FINAL": 350}[s]) for s in ("VAL", "CAL", "FINAL")}
    for s, f in md.items():
        f.to_parquet(MIXED / f"mixed_documents_{s.lower()}.parquet", index=False)
    v611 = pd.read_parquet(D611 / "datasets" / "f006_1_1_validation.parquet")
    hg = v611["group_id"].drop_duplicates().sample(frac=1.0, random_state=SEED)
    half = set(hg.iloc[: len(hg) // 2])
    hv = cap(v611[v611["group_id"].isin(half)], HIST_VAL, ["primary"], SEED).copy()
    hc = cap(v611[~v611["group_id"].isin(half)], HIST_CAL, ["primary"], SEED).copy()
    for h_ in (hv, hc):
        h_["origin"], h_["paragraph_language"], h_["mixed_language"] = "f006_1_1_validation", h_["language"], False
    frames = {"validation": pd.concat([sides["VAL"], hv], ignore_index=True), "calibration": pd.concat([sides["CAL"], hc], ignore_index=True),
              "final": sides["FINAL"]}
    train_new = sides["TRAIN"][sides["TRAIN"]["cls"] != "PRESENTATION_EXCLUDED"].reset_index(drop=True)
    ev_all = pd.concat([frames[k] for k in frames], ignore_index=True)
    for _ in range(10):
        drop = near_dup_members(ev_all, train_new)
        if not drop:
            break
        log(f"dropping {len(drop)} TRAIN rows near-duplicate to evaluation rows")
        train_new = train_new.drop(index=sorted(drop)).reset_index(drop=True)
    for k in ("validation", "calibration"):
        for _ in range(4):
            d_ = near_dup_members(frames["final"], frames[k].reset_index(drop=True))
            if not d_:
                break
            frames[k] = frames[k].reset_index(drop=True).drop(index=sorted(d_)).reset_index(drop=True)
    tr_g = set(train_new["group_id"]) | hist_train_g
    tr_h = set(train_new["text_hash"]) | set(idx.loc[idx["split"] == "train", "text_hash"].dropna()) | set(ex62["text_hash"])
    tr_p = set(train_new["parent_id"].dropna()) | set(train_new["id"])
    tr_s = set(train_new["source_id"].dropna())

    def L(f, g, h, p, s):
        f = f[f["origin"] != "f006_1_1_validation"] if "origin" in f else f
        return {"group": len(set(f["group_id"].dropna()) & g), "exact": len(set(f["text_hash"].dropna()) & h),
                "parent": len((set(f["parent_id"].dropna()) | set(f["id"])) & p), "source": len(set(f["source_id"].dropna()) & s)}

    leak = {f"TRAIN_vs_{k}": {**L(f, tr_g, tr_h, tr_p, tr_s), "near": len(near_dup_members(f.reset_index(drop=True), train_new))} for k, f in frames.items()}
    fin = frames["final"]
    fg, fh, fp, fs = set(fin["group_id"]), set(fin["text_hash"].dropna()), set(fin["parent_id"].dropna()) | set(fin["id"]), set(fin["source_id"].dropna())
    for k in ("validation", "calibration"):
        leak[f"FINAL_vs_{k}"] = {**L(frames[k], fg, fh, fp, fs), "near": len(near_dup_members(fin, frames[k].reset_index(drop=True)))}
    leak["FINAL_claude_rows"] = int((fin["dataset"] == "claude_multilingual").sum())
    flat = [v for d_ in leak.values() for v in (d_.values() if isinstance(d_, dict) else [d_])]
    leak["result"] = "PASS" if all(v == 0 for v in flat) else "FAIL"
    gates = {"CROSS_SPLIT_LEAKAGE": sum(v["exact"] + v["near"] for k, v in leak.items() if isinstance(v, dict)),
             "PARENT_LEAKAGE": sum(v["parent"] for v in leak.values() if isinstance(v, dict)),
             "SOURCE_LEAKAGE": sum(v["source"] for v in leak.values() if isinstance(v, dict)),
             "GROUP_LEAKAGE": sum(v["group"] for v in leak.values() if isinstance(v, dict))}
    log("leakage " + json.dumps(leak))
    if leak["result"] != "PASS":
        write_json(MANI / "f006_3_leakage_FAIL.json", {"leak": leak, "gates": gates})
        raise SystemExit("STOP_BEFORE_TRAINING: leakage")
    out = {}
    for k, f in frames.items():
        f = f[f["cls"] != "PRESENTATION_EXCLUDED"].copy()
        f["label"] = (f["fine_label"] != "HUMAN").astype(int)
        for c in KEEP:
            if c not in f:
                f[c] = None
        f = f[KEEP].drop_duplicates("id").reset_index(drop=True)
        f.to_parquet(SPLITS / f"f006_3_{'final_external_holdout' if k == 'final' else k}.parquet", index=False)
        out[k] = f
    tn = train_new.copy()
    tn["is_adversarial"], tn["is_mixed"] = False, tn["fine_label"] == "MIXED"
    tn["dataset"] = "f0063_" + tn["dataset"].astype(str)
    tn["generator_family"] = tn["generator"].astype(str)
    cols = ["id", "dataset", "fine_label", "language", "domain", "is_adversarial", "is_mixed", "n_words", "group_id", "generator_family", "text_original",
            "text_normalized", "span_labels"]
    extra = pd.concat([pd.read_parquet(D62 / "datasets" / "splits" / "f006_2_train_extra.parquet")[cols], tn[cols]], ignore_index=True).drop_duplicates("id")
    extra.to_parquet(SPLITS / "f006_3_train_extra.parquet", index=False)

    def summary(f):
        return {"docs": int(len(f)), "humans": int((f["label"] == 0).sum()), "machines": int((f["label"] == 1).sum()),
                "by_language": f["language"].astype(str).value_counts().to_dict(), "by_primary": f["primary"].astype(str).value_counts().to_dict(),
                "datasets": f["dataset"].astype(str).value_counts().to_dict(), "generators": f["generator"].astype(str).value_counts().head(30).to_dict(),
                "mixed_rows": int((f["fine_label"] == "MIXED").sum())}

    common = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "dedup": dedup, "leakage": leak, "gates": gates}
    write_json(mp, {"name": "F006_3_FINAL_EXTERNAL_HOLDOUT", **common, **summary(out["final"]), "ids_sha256": sha256_ids(out["final"]["id"]),
                    "holdout_file_sha256": sha256_file(SPLITS / "f006_3_final_external_holdout.parquet"), "LOCKED": True,
                    "mixed_documents_file_sha256": sha256_file(MIXED / "mixed_documents_final.parquet"),
                    "rule": "no Claude rows; evaluated ONCE after F006_3_MODEL_LOCK"})
    for k in ("validation", "calibration"):
        write_json(MANI / f"f006_3_{k}.json", {"name": f"F006_3_{k.upper()}", **common, **summary(out[k]), "file_sha256": sha256_file(SPLITS / f"f006_3_{k}.parquet")})
    write_json(MANI / "f006_3_train_extra.json", {"rows": int(len(extra)), "new_rows": int(len(tn)), "new_by_language": tn["language"].astype(str).value_counts().to_dict(),
                                                  "new_by_dataset_label": (tn["dataset"] + "|" + tn["fine_label"].astype(str)).value_counts().to_dict(),
                                                  "file_sha256": sha256_file(SPLITS / "f006_3_train_extra.parquet")})
    write_json(REPO / "reports" / "f006_3" / "split_report.json", {**common, "validation": summary(out["validation"]), "calibration": summary(out["calibration"]),
                                                                   "final_metadata_only": summary(out["final"]), "train_new": int(len(tn)),
                                                                   "mixed_documents": {s: int(f["parent_document_id"].nunique()) for s, f in md.items()}})
    log(f"LOCKED F006_3 final {len(out['final']):,}; validation {len(out['validation']):,}; calibration {len(out['calibration']):,}; train new {len(tn):,} "
        f"({time.time() - t0:.0f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
