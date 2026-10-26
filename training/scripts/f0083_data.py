"""F008.3: multilingual / cross-language pair data, lineage-safe splits, leakage audit, frozen holdouts (Track B only).

    python scripts/f0083_data.py

Sources (reports/F008_3_LICENSE_AUDIT.json):
  TRAIN       Claude multilingual bundles (training / aux validation only), TaPaCo (CC BY 2.0) es en pt fr de, STSb-multi-MT (research terms)
              train, XNLI (CC BY-NC 4.0) train contradiction / neutral as hard negatives, PAWS-X es de fr TRAIN (historical family;
              dev / test ids never), F008.2 TRAIN replay
  VALIDATION  FLORES-200 dev articles (half), TaPaCo held-out sets, STSb dev, XNLI validation (half), Claude aux slice (10 % of seeds)
  CALIBRATION FLORES-200 dev articles (other half), TaPaCo held-out sets, XNLI validation (other half), Claude aux slice (5 %)
  FINAL       FLORES-200 devtest (cross-language, CC BY-SA 4.0), Opusparcus test de en fr (human-annotated, CC BY-NC 4.0), XNLI test
  REGRESSION  Sushi (LONG_DISTANCE_PARAPHRASE_REGRESSION), F008.2 final holdout, PAWS-X es test
Unit = parent (seed / FLORES sentence id / TaPaCo set / XNLI pair / STSb row): every translation and transformation of a parent stays in
one split. Gates: CROSS_SPLIT_LEAKAGE = PARENT_LEAKAGE = SOURCE_LEAKAGE = TRANSLATION_LINEAGE_LEAKAGE = 0, else STOP_BEFORE_TRAINING.
"""

from __future__ import annotations

import io
import json
import random
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import key, norm_text, sha256_file, unit  # noqa: E402
from f0082_data import near_hits  # noqa: E402

DRIVE = Path("/content/drive/MyDrive/turniting")
D = DRIVE / "f008_3"
DS = D / "datasets"
RAW, PAIRS, SPLITS, MANI = DS / "raw", DS / "pairs", DS / "splits", DS / "manifests"
REPO = Path(__file__).resolve().parents[1]
SEED = 83008
L5 = ["es", "en", "pt", "fr", "de"]
FLORES = {"es": "spa_Latn", "en": "eng_Latn", "pt": "por_Latn", "fr": "fra_Latn", "de": "deu_Latn"}
CROSS = [("es", "en"), ("es", "pt"), ("es", "fr"), ("es", "de"), ("en", "pt"), ("en", "fr"), ("en", "de")]
HF = "https://huggingface.co/datasets/{repo}/resolve/{rev}/{path}"
TAPACO_REV, XNLI_REV, STSB_REV, PAWS_REV = "1c7374c61fec4c1e94cb2d840527d31d6ef32e00", "b8dd5d7af51114dbda02c0e3f6133f332186418e", \
    "3acaa3dd8c91649e0b8e627ffad891f059e47c8c", "4cd8187c404bda33cb1f62b49b001115862acf37"
OPUS_REV = "b2961bc20518a180893c23ef2b4a46de13664126"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def fetch(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        for k in range(5):
            try:
                urllib.request.urlretrieve(url, dest)
                break
            except Exception as e:  # noqa: BLE001
                log(f"retry {k + 1} {dest.name}: {type(e).__name__}")
                time.sleep(2 ** (k + 1))
        else:
            raise SystemExit(f"ABORT: {url}")
    return dest


def P(**kw) -> dict:
    base = {"pair_id": None, "text_a": None, "text_b": None, "pair_class": None, "label": None, "score": np.nan, "lang_a": None, "lang_b": None,
            "cross_language": False, "dataset": None, "parent_source_id": None, "lineage": None, "translation_lineage": None, "doc_level": False}
    base.update(kw)
    base["cross_language"] = base["lang_a"] != base["lang_b"]
    base["lineage"] = base["lineage"] or base["parent_source_id"]
    base["translation_lineage"] = base["translation_lineage"] or base["parent_source_id"]
    return base


# ------------------------------------------------------------------ sources
def flores() -> tuple[dict, pd.DataFrame]:
    tgz = fetch("https://dl.fbaipublicfiles.com/nllb/flores200_dataset.tar.gz", RAW / "flores200_dataset.tar.gz")
    out, meta = {}, {}
    with tarfile.open(tgz) as t:
        for split in ("dev", "devtest"):
            for l, code in FLORES.items():
                m = next(x for x in t.getmembers() if x.name.endswith(f"{split}/{code}.{split}"))
                out[(split, l)] = [norm_text(s) for s in t.extractfile(m).read().decode("utf-8").splitlines()]
            mm = next((x for x in t.getmembers() if x.name.endswith(f"metadata_{split}.tsv")), None)
            if mm is not None:
                meta[split] = pd.read_csv(io.BytesIO(t.extractfile(mm).read()), sep="\t")
    return out, meta


def flores_pairs(fl: dict, meta: dict, split: str, side_of) -> list[dict]:
    rows = []
    n = len(fl[(split, "es")])
    urls = meta[split]["URL"].tolist() if split in meta and "URL" in meta[split] else [f"{split}:{i // 10}" for i in range(n)]
    rng = random.Random(f"{SEED}:{split}")
    for i in range(n):
        pid = f"flores:{split}:{i}"
        side = side_of(urls[i])
        for a, b in CROSS:
            rows.append(P(pair_id=f"{pid}:{a}-{b}", text_a=fl[(split, a)][i], text_b=fl[(split, b)][i], pair_class="DIRECT_TRANSLATION", label=1.0,
                          lang_a=a, lang_b=b, dataset=f"flores200_{split}", parent_source_id=pid, side=side, article=urls[i]))
            j = rng.choice([k for k in range(max(0, i - 6), min(n, i + 7)) if k != i])  # same-article neighbour: same topic, other content
            rows.append(P(pair_id=f"{pid}:{a}-{b}:neg", text_a=fl[(split, a)][i], text_b=fl[(split, b)][j], pair_class="SAME_TOPIC_CROSS_LANGUAGE",
                          label=0.0, lang_a=a, lang_b=b, dataset=f"flores200_{split}", parent_source_id=pid, side=side, article=urls[i],
                          lineage=f"{pid}|flores:{split}:{j}"))
    # article-level long-distance documents (cross-language): 3-5 consecutive sentences
    by = {}
    for i, u in enumerate(urls):
        by.setdefault(u, []).append(i)
    for u, ids in by.items():
        if len(ids) < 3:
            continue
        ids = ids[:5]
        for a, b in (("es", "en"), ("en", "es"), ("es", "pt"), ("de", "es"), ("fr", "en")):
            rows.append(P(pair_id=f"flores:{split}:doc:{u}:{a}-{b}", text_a=" ".join(fl[(split, a)][k] for k in ids),
                          text_b=" ".join(fl[(split, b)][k] for k in ids), pair_class="TRANSLATED_DOCUMENT", label=1.0, lang_a=a, lang_b=b,
                          dataset=f"flores200_{split}", parent_source_id=f"flores:{split}:art:{u}", side=side_of(u), article=u, doc_level=True,
                          lineage="|".join(f"flores:{split}:{k}" for k in ids)))
    return rows


def tapaco() -> list[dict]:
    rows = []
    for l in L5:
        f = fetch(HF.format(repo="community-datasets/tapaco", rev=TAPACO_REV, path=f"{l}/train-00000-of-00001.parquet"), RAW / f"tapaco_{l}.parquet")
        t = pd.read_parquet(f)
        t["paraphrase"] = t["paraphrase"].map(norm_text)
        rng = random.Random(f"{SEED}:tapaco:{l}")
        sets = [g for _, g in t.groupby("paraphrase_set_id") if len(g) >= 2]
        rng.shuffle(sets)
        sets = sets[:2500]
        allsent = t["paraphrase"].tolist()
        for g in sets:
            sid = f"tapaco:{l}:{g['paraphrase_set_id'].iloc[0]}"
            s = g["paraphrase"].tolist()
            rows.append(P(pair_id=f"{sid}:p", text_a=s[0], text_b=s[1], pair_class="FAITHFUL_PARAPHRASE", label=1.0, lang_a=l, lang_b=l,
                          dataset="tapaco", parent_source_id=sid))
            rows.append(P(pair_id=f"{sid}:n", text_a=s[0], text_b=rng.choice(allsent), pair_class="SAME_TOPIC_NEGATIVE", label=0.0, lang_a=l, lang_b=l,
                          dataset="tapaco", parent_source_id=sid))
    return rows


def stsb() -> list[dict]:
    rows = []
    frames = {}
    for l in L5:
        for sp in ("train", "dev"):
            frames[(l, sp)] = pd.read_parquet(fetch(HF.format(repo="PhilipMay/stsb_multi_mt", rev=STSB_REV, path=f"{l}/{sp}-00000-of-00001.parquet"),
                                                    RAW / f"stsb_{l}_{sp}.parquet"))
    for sp in ("train", "dev"):
        n = len(frames[("en", sp)])
        for i in range(n):
            pid = f"stsb:{sp}:{i}"
            sc = float(frames[("en", sp)]["similarity_score"].iat[i])
            lab = 1.0 if sc >= 4.0 else 0.0 if sc <= 1.5 else np.nan
            for l in L5:
                r = frames[(l, sp)].iloc[i]
                rows.append(P(pair_id=f"{pid}:{l}", text_a=norm_text(r.sentence1), text_b=norm_text(r.sentence2), pair_class="STS_GRADED", label=lab,
                              score=sc, lang_a=l, lang_b=l, dataset=f"stsb_multi_mt_{sp}", parent_source_id=pid))
            a, b = random.Random(f"{SEED}:{pid}").choice(CROSS)
            rows.append(P(pair_id=f"{pid}:{a}-{b}", text_a=norm_text(frames[(a, sp)]["sentence1"].iat[i]), text_b=norm_text(frames[(b, sp)]["sentence2"].iat[i]),
                          pair_class="STS_GRADED_CROSS", label=lab, score=sc, lang_a=a, lang_b=b, dataset=f"stsb_multi_mt_{sp}", parent_source_id=pid))
    return rows


def xnli() -> dict[str, list[dict]]:
    out = {}
    for sp, files in (("train", [f"all_languages/train-0000{k}-of-00004.parquet" for k in range(4)]), ("validation", ["all_languages/validation-00000-of-00001.parquet"]),
                      ("test", ["all_languages/test-00000-of-00001.parquet"])):
        df = pd.concat([pd.read_parquet(fetch(HF.format(repo="facebook/xnli", rev=XNLI_REV, path=f), RAW / f"xnli_{f.replace('/', '_')}")) for f in files])
        if sp == "train":
            df = df.sample(9000, random_state=SEED)
        rows = []
        for i, r in enumerate(df.itertuples(index=False)):
            if int(r.label) == 0:
                continue  # entailment is not paraphrase; it is not used as a positive nor as a negative
            prem = dict(r.premise)
            hyp = dict(zip(r.hypothesis["language"], r.hypothesis["translation"]))
            pid = f"xnli:{sp}:{sha256_text_short(prem.get('en', ''))}"
            cls = "CONTRADICTION" if int(r.label) == 2 else "SAME_TOPIC_NEGATIVE"
            rng = random.Random(f"{SEED}:{pid}:{i}")
            a = rng.choice(["es", "en", "fr", "de"])
            b = a if rng.random() < 0.5 else rng.choice([x for x in ["es", "en", "fr", "de"] if x != a])
            if a not in prem or b not in hyp:
                continue
            rows.append(P(pair_id=f"{pid}:{i}:{a}-{b}", text_a=norm_text(prem[a]), text_b=norm_text(hyp[b]), pair_class=cls + ("_CROSS_LANGUAGE" if a != b else ""),
                          label=0.0, lang_a=a, lang_b=b, dataset=f"xnli_{sp}", parent_source_id=pid))
        out[sp] = rows
    return out


def sha256_text_short(t: str) -> str:
    import hashlib

    return hashlib.sha256(t.encode()).hexdigest()[:16]


def pawsx() -> list[dict]:
    rows = []
    hold = set()
    for l in ("es", "de", "fr"):
        for sp in ("validation", "test"):
            hold |= set(pd.read_parquet(fetch(HF.format(repo="google-research-datasets/paws-x", rev=PAWS_REV, path=f"{l}/{sp}-00000-of-00001.parquet"),
                                              RAW / f"pawsx_{l}_{sp}.parquet"))["id"])
    for l in ("de", "fr"):
        t = pd.read_parquet(fetch(HF.format(repo="google-research-datasets/paws-x", rev=PAWS_REV, path=f"{l}/train-00000-of-00001.parquet"), RAW / f"pawsx_{l}_train.parquet"))
        t = t[~t["id"].isin(hold) & t["sentence1"].notna() & t["sentence2"].notna()].sample(12000, random_state=SEED)
        for r in t.itertuples(index=False):
            pid = f"pawsx_src:{key(norm_text(r.sentence1))[:16]}"
            rows.append(P(pair_id=f"pawsx:{l}:{r.id}", text_a=norm_text(r.sentence1), text_b=norm_text(r.sentence2),
                          pair_class="PAWS_PARAPHRASE" if r.label == 1 else "LEXICAL_HARD_NEGATIVE", label=float(r.label), lang_a=l, lang_b=l,
                          dataset=f"pawsx_{l}_train", parent_source_id=pid))
    return rows


def opusparcus() -> list[dict]:
    f = fetch(HF.format(repo="GEM/opusparcus", rev=OPUS_REV, path="test.jsonl"), RAW / "opusparcus_test.jsonl")
    rows = []
    for ln in f.read_text(encoding="utf-8").splitlines():
        r = json.loads(ln)
        if r["lang"] not in ("de", "en", "fr"):
            continue
        sc = float(r["annot_score"])
        lab = 1.0 if sc >= 3.0 else 0.0 if sc <= 2.0 else np.nan  # Opusparcus scale 1-4: >= 3 paraphrase, <= 2 not (documented threshold)
        pid = f"opusparcus:{r['orig_id']}"
        rows.append(P(pair_id=pid, text_a=norm_text(r["sent1"]), text_b=norm_text(r["sent2"]), pair_class="HUMAN_PARAPHRASE" if lab == 1 else "HUMAN_NON_PARAPHRASE",
                      label=lab, score=sc, lang_a=r["lang"], lang_b=r["lang"], dataset="opusparcus_test", parent_source_id=pid))
    return rows


# ------------------------------------------------------------------ main
def main() -> int:
    mp = MANI / "f008_3_final_external_holdout.json"
    if mp.exists() and json.loads(mp.read_text()).get("LOCKED"):
        m = json.loads(mp.read_text())
        assert sha256_file(SPLITS / "f008_3_final_external_holdout.parquet") == m["file_sha256"]
        log("F008_3 splits already frozen; verified")
        return 0
    for p in (RAW, PAIRS, SPLITS, MANI):
        p.mkdir(parents=True, exist_ok=True)
    fl, meta = flores()
    dev = pd.DataFrame(flores_pairs(fl, meta, "dev", lambda u: "VALIDATION" if unit(f"fl:{u}", SEED) < 0.5 else "CALIBRATION"))
    devtest = pd.DataFrame(flores_pairs(fl, meta, "devtest", lambda u: "FINAL"))
    tp = pd.DataFrame(tapaco())
    tp["side"] = tp["parent_source_id"].map(lambda s: "TRAIN" if unit("tp:" + s, SEED) < 0.85 else "VALIDATION" if unit("tp:" + s, SEED) < 0.93 else "CALIBRATION")
    st = pd.DataFrame(stsb())
    st["side"] = np.where(st["dataset"].str.endswith("train"), "TRAIN",
                          np.where(st["parent_source_id"].map(lambda s: unit("st:" + s, SEED) < 0.5), "VALIDATION", "CALIBRATION"))
    xn = xnli()
    xtr, xva, xte = (pd.DataFrame(xn[k]) for k in ("train", "validation", "test"))
    xtr["side"] = "TRAIN"
    xva["side"] = np.where(xva["parent_source_id"].map(lambda s: unit("xv:" + s, SEED) < 0.5), "VALIDATION", "CALIBRATION")
    xte["side"] = "FINAL"
    pw = pd.DataFrame(pawsx()).assign(side="TRAIN")
    op = pd.DataFrame(opusparcus()).assign(side="FINAL")
    cl = pd.read_parquet(PAIRS / "claude_pairs_multilingual.parquet") if (PAIRS / "claude_pairs_multilingual.parquet").exists() else pd.DataFrame()
    if len(cl):
        cl["side"] = cl["parent_source_id"].map(lambda s: "TRAIN" if unit("cl:" + s, SEED) < 0.85 else "VALIDATION" if unit("cl:" + s, SEED) < 0.95 else "CALIBRATION")
        cl["score"] = np.nan
        cl["doc_level"] = False
    replay = pd.read_parquet(DRIVE / "f008_2" / "datasets" / "splits" / "f008_2_train.parquet")
    replay = replay.assign(side="TRAIN", lang_a="es", lang_b=replay["lang_b"].fillna("es"), dataset="replay_f008_2:" + replay["dataset"].astype(str),
                           translation_lineage=replay["parent_source_id"], doc_level=False, score=np.nan)
    replay["cross_language"] = replay["lang_a"] != replay["lang_b"]
    allp = pd.concat([dev, devtest, tp, st, xtr, xva, xte, pw, op, cl, replay], ignore_index=True)
    allp = allp[allp["text_a"].notna() & allp["text_b"].notna() & (allp["text_a"].str.len() > 3) & (allp["text_b"].str.len() > 3)]
    n0 = len(allp)
    allp["k"] = allp["text_a"].map(key) + "|" + allp["text_b"].map(key)
    allp = allp.drop_duplicates("k").reset_index(drop=True)
    exact_within = n0 - len(allp)
    # ---------------- leakage: TRAIN rows may not touch any evaluation text / parent / lineage
    ev = allp[allp["side"] != "TRAIN"]
    tr = allp[allp["side"] == "TRAIN"]
    ev_keys = set(ev["text_a"].map(key)) | set(ev["text_b"].map(key))
    ex = tr["text_a"].map(key).isin(ev_keys) | tr["text_b"].map(key).isin(ev_keys)
    tr = tr[~ex]
    ev_texts = list(dict.fromkeys(ev["text_a"].tolist() + ev["text_b"].tolist()))
    near = near_hits(ev_texts, tr["text_a"].tolist()) | near_hits(ev_texts, tr["text_b"].tolist())
    tr = tr.reset_index(drop=True).drop(index=sorted(near)).reset_index(drop=True)
    ev_par = set(ev["parent_source_id"]) | set(ev["lineage"]) | set(ev["translation_lineage"])
    tr = tr[~(tr["parent_source_id"].isin(ev_par) | tr["lineage"].isin(ev_par) | tr["translation_lineage"].isin(ev_par))]
    sides = {s: g.reset_index(drop=True) for s, g in pd.concat([tr, ev]).groupby("side")}
    fin = sides["FINAL"]
    fin_keys = set(fin["text_a"].map(key)) | set(fin["text_b"].map(key))
    other = pd.concat([sides["VALIDATION"], sides["CALIBRATION"]])
    leak = {"TRAIN_vs_eval_exact": int((tr["text_a"].map(key).isin(ev_keys) | tr["text_b"].map(key).isin(ev_keys)).sum()),
            "TRAIN_vs_eval_near": len(near_hits(ev_texts, tr["text_a"].tolist()) | near_hits(ev_texts, tr["text_b"].tolist())),
            "TRAIN_vs_eval_parent": int(tr["parent_source_id"].isin(ev_par).sum()), "TRAIN_vs_eval_lineage": int(tr["lineage"].isin(ev_par).sum()),
            "TRAIN_vs_eval_translation_lineage": int(tr["translation_lineage"].isin(ev_par).sum()),
            "FINAL_vs_VALCAL_parent": len(set(fin["parent_source_id"]) & set(other["parent_source_id"])),
            "FINAL_vs_VALCAL_exact": len(fin_keys & (set(other["text_a"].map(key)) | set(other["text_b"].map(key)))),
            "VALIDATION_vs_CALIBRATION_parent": len(set(sides["VALIDATION"]["parent_source_id"]) & set(sides["CALIBRATION"]["parent_source_id"])),
            "CLAUDE_rows_in_FINAL": int((fin["dataset"] == "claude_pairs_multilingual").sum())}
    leak["CROSS_SPLIT_LEAKAGE"] = leak["TRAIN_vs_eval_exact"] + leak["TRAIN_vs_eval_near"] + leak["FINAL_vs_VALCAL_exact"]
    leak["PARENT_LEAKAGE"] = leak["TRAIN_vs_eval_parent"] + leak["FINAL_vs_VALCAL_parent"] + leak["VALIDATION_vs_CALIBRATION_parent"]
    leak["SOURCE_LEAKAGE"] = leak["TRAIN_vs_eval_lineage"]
    leak["TRANSLATION_LINEAGE_LEAKAGE"] = leak["TRAIN_vs_eval_translation_lineage"]
    leak["result"] = "PASS" if all(v == 0 for k, v in leak.items() if k != "result") else "FAIL"
    log("leakage " + json.dumps(leak))
    if leak["result"] != "PASS":
        (MANI / "f008_3_leakage_FAIL.json").write_text(json.dumps(leak, indent=2))
        raise SystemExit("STOP_BEFORE_TRAINING: leakage")
    regs = {}
    sushi = pd.read_parquet(DRIVE / "f008_2" / "datasets" / "splits" / "f008_2_final_external_holdout.parquet")
    regs["long_distance_regression_sushi"] = sushi
    regs["regression_paws_es_test"] = pd.read_parquet(DRIVE / "f008_2" / "datasets" / "splits" / "f008_2_regression_paws_test.parquet")
    out = {"train": sides["TRAIN"], "validation": sides["VALIDATION"], "calibration": sides["CALIBRATION"], "final_external_holdout": fin, **regs}
    for k, f_ in out.items():
        f_.drop(columns=[c for c in ("k",) if c in f_.columns]).to_parquet(SPLITS / f"f008_3_{k}.parquet", index=False)

    def summ(f_):
        return {"pairs": int(len(f_)), "cross_language": int(f_["cross_language"].fillna(False).sum()) if "cross_language" in f_ else 0,
                "by_dataset": f_["dataset"].value_counts().to_dict(), "by_class": f_["pair_class"].value_counts().to_dict(),
                "by_lang_pair": (f_["lang_a"].astype(str) + "-" + f_["lang_b"].astype(str)).value_counts().head(20).to_dict() if "lang_a" in f_ else {},
                "parents": int(f_["parent_source_id"].nunique())}

    sm = {k: summ(v) for k, v in out.items()}
    common = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "exact_dup_removed": int(exact_within),
              "train_exact_vs_eval_removed": int(ex.sum()), "train_near_vs_eval_removed": len(near), "leakage": leak}
    for k in out:
        (MANI / f"f008_3_{k}.json").write_text(json.dumps({"name": f"F008_3_{k.upper()}", **common, **sm[k],
                                                           "file_sha256": sha256_file(SPLITS / f"f008_3_{k}.parquet")}, indent=2, ensure_ascii=False))
    mp.write_text(json.dumps({"name": "F008_3_FINAL_EXTERNAL_HOLDOUT", **common, **sm["final_external_holdout"], "LOCKED": True,
                              "file_sha256": sha256_file(SPLITS / "f008_3_final_external_holdout.parquet"),
                              "rule": "never trained / tuned / calibrated on; evaluated ONCE after F008_3_MODEL_LOCK"}, indent=2, ensure_ascii=False))
    (REPO / "reports" / "f008_3").mkdir(parents=True, exist_ok=True)
    (REPO / "reports" / "f008_3" / "split_report.json").write_text(json.dumps({**common, "splits": sm}, indent=2, ensure_ascii=False))
    log("splits " + json.dumps({k: v["pairs"] for k, v in sm.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
