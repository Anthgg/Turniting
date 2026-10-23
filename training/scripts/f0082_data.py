"""F008.2: pair datasets, parent grouping, dedup, leakage audit and frozen splits (Track B only).

    python scripts/f0082_data.py

Sources (reports/F008_2_LICENSE_AUDIT.json): PAWS-X (historical F008 source; TRAIN split re-used only after the leakage audit),
Sushi corpus (CC0, new, human-made: FINAL_EXTERNAL_HOLDOUT), STS-es via MTEB (CC BY 4.0: HARD_NEGATIVE_OOD + graded check),
Claude pairs (TRAINING ONLY). ParMEX (no license) / STS-es train (undeclared) / Zenodo 5159398 (PAN-PC-11 lineage) are not used.

Splits (unit = parent: a seed / source sentence and every transformation of it):
  TRAIN              Claude pairs + PAWS-X es TRAIN (rows touching any evaluation sentence are dropped)
  VALIDATION         PAWS-X es dev, parent half A (+ en<->es translated pairs + rule-based negation / number / entity negatives)
  CALIBRATION        PAWS-X es dev, parent half B (same construction)
  TRANSLATED_OOD     PAWS-X dev es <-> de / fr (language pairs never trained)
  HARD_NEGATIVE_OOD  STS-es (MTEB test): rule-based hard negatives + graded pairs (score >= 4 positive, <= 1 negative; middle kept graded only)
  FINAL_EXTERNAL_HOLDOUT  Sushi corpus sentence pairs + document pairs (one article family, held out entirely)
  REGRESSION_HOLDOUT PAWS-X es test (F008 final holdout family; continuity only)
Gate: CROSS_SPLIT_LEAKAGE = 0 (exact key, MinHash near >= 0.8, parent, source, lineage) else STOP_BEFORE_TRAINING.
"""

from __future__ import annotations

import json
import random
import re
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import (MANI, PAIRS, PAWSX, RAW, REPO, SEED, SPLITS, STSES, SUSHI, key, norm_text, sha256_file, unit,  # noqa: E402
                          write_json)

SUSHI_FILES = ["sushi_dataset.txt", "sushi0.txt"] + [f"sushi_high{i}.txt" for i in range(1, 6)] + [f"sushi_low{i}.txt" for i in (1, 2, 3, 4, 5)] + \
              ["sushi_low4a.txt", "sushi_low4b.txt", "sushi_nopa1.txt", "sushi_nopa2a.txt", "sushi_nopa2b.txt", "sushi_nopa3.txt"]
NEG_RULES = [(r"\b(es|era|fue|será|son|eran|fueron|está|están|estaba|tiene|tienen|tenía|ha|han|había|puede|pueden)\b", r"no \1")]


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
            raise SystemExit(f"ABORT: download failed {url}")
    return dest


# ------------------------------------------------------------------ rule-based (non-LLM) hard negatives for evaluation sets

def negate(s: str) -> str | None:
    m = re.search(NEG_RULES[0][0], s)
    if not m or re.search(r"\bno\s+" + re.escape(m.group(1)) + r"\b", s):
        return None
    return s[:m.start()] + "no " + s[m.start():]


def change_number(s: str, rng: random.Random) -> str | None:
    nums = list(re.finditer(r"\b\d{1,4}\b", s))
    if not nums:
        return None
    m = rng.choice(nums)
    v = int(m.group(0))
    nv = v + rng.choice([1, 2, 3, 5, 10, 11]) if v < 1900 or v > 2100 else v + rng.choice([-7, -3, 4, 9])
    return s[:m.start()] + str(nv) + s[m.end():]


def change_entity(s: str, pool: list[str], rng: random.Random) -> str | None:
    caps = [m for m in re.finditer(r"(?<!^)(?<![.!?]\s)\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)", s)]
    caps = [m for m in caps if m.start() > 0]
    if not caps or not pool:
        return None
    m = rng.choice(caps)
    rep = rng.choice([p for p in pool if p != m.group(1)] or pool)
    return s[:m.start()] + rep + s[m.end():]


def entities(texts) -> list[str]:
    out = set()
    for t in texts:
        out.update(m.group(1) for m in re.finditer(r"(?<=\s)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{3,}(?:\s[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)", t))
    return sorted(out)


def rule_negatives(anchors: pd.DataFrame, rng: random.Random, tag: str) -> list[dict]:
    pool = entities(anchors["text_a"].tolist())
    rows = []
    for r in anchors.itertuples(index=False):
        for cls, fn in (("NEGATION_HARD_NEGATIVE", lambda s: negate(s)), ("NUMBER_CHANGED_NEGATIVE", lambda s: change_number(s, rng)),
                        ("ENTITY_CHANGED_NEGATIVE", lambda s: change_entity(s, pool, rng))):
            b = fn(r.text_a)
            if b and b != r.text_a:
                rows.append({**r._asdict(), "pair_id": f"{r.pair_id}:{cls}", "text_b": b, "pair_class": cls, "label": 0.0, "lang_b": "es",
                             "dataset": f"{tag}_rule_negative", "transformation": "rule_based (no LLM)"})
    return rows


def near_hits(a_texts: list[str], b_texts: list[str]) -> set:
    """indices of b near-duplicate (MinHash J >= 0.8) to any a"""
    from turniting_train.dedup import MinHasher, band_hashes

    if not a_texts or not b_texts:
        return set()
    mh = MinHasher(num_perm=64, seed=42, max_chars=2000)
    sa = np.stack([mh.signature(t) for t in a_texts])
    sb = np.stack([mh.signature(t) for t in b_texts])
    ba, bb = band_hashes(sa, 8), band_hashes(sb, 8)
    pairs = []
    for k in range(ba.shape[1]):
        fa = pd.DataFrame({"v": ba[:, k], "ia": np.arange(len(sa))}).groupby("v").head(64)
        m = pd.DataFrame({"v": bb[:, k], "ib": np.arange(len(sb))}).merge(fa, on="v")
        if len(m):
            pairs.append(m[["ia", "ib"]].to_numpy())
    if not pairs:
        return set()
    pr = np.unique(np.concatenate(pairs), axis=0)
    j = (sa[pr[:, 0]] == sb[pr[:, 1]]).mean(axis=1)
    return set(int(x) for x in pr[j >= 0.8, 1])


def main() -> int:
    man_path = MANI / "f008_2_final_external_holdout.json"
    if man_path.exists() and json.loads(man_path.read_text()).get("LOCKED"):
        m = json.loads(man_path.read_text())
        assert sha256_file(SPLITS / "f008_2_final_external_holdout.parquet") == m["file_sha256"], "locked holdout changed"
        log("F008_2 splits already frozen; verified")
        return 0
    for p in (RAW, PAIRS, SPLITS, MANI):
        p.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    dl = {}
    paws = {}
    for lang in ("es", "en", "de", "fr"):
        for sp in ("train", "validation", "test"):
            if lang != "es" and sp != "validation":
                continue
            f = fetch(PAWSX.format(lang=lang, split=sp), RAW / f"pawsx_{lang}_{sp}.parquet")
            paws[(lang, sp)] = pd.read_parquet(f)
            dl[f.name] = sha256_file(f)
    for fn in SUSHI_FILES:
        f = fetch(SUSHI.format(f=fn), RAW / "sushi" / fn)
        dl["sushi/" + fn] = sha256_file(f)
    f = fetch(STSES, RAW / "stses_test.parquet")
    dl[f.name] = sha256_file(f)

    def paws_rows(df, split, tag):
        df = df[df["sentence1"].notna() & df["sentence2"].notna()]
        return pd.DataFrame({"pair_id": [f"{tag}:{i}" for i in df["id"]], "text_a": df["sentence1"].map(norm_text), "text_b": df["sentence2"].map(norm_text),
                             "label": df["label"].astype(float), "pair_class": np.where(df["label"] == 1, "PAWS_PARAPHRASE", "LEXICAL_HARD_NEGATIVE"),
                             "lang_b": "es", "dataset": tag, "paws_id": df["id"].values, "source_split": split})

    es_dev = paws_rows(paws[("es", "validation")], "validation", "pawsx_es_dev")
    es_test = paws_rows(paws[("es", "test")], "test", "pawsx_es_test")
    es_train = paws_rows(paws[("es", "train")], "train", "pawsx_es_train")
    for f_ in (es_dev, es_test, es_train):
        f_["parent_source_id"] = "pawsx_src:" + f_["text_a"].map(key).str[:16]
        f_["lineage"] = f_["parent_source_id"]
    # dev halves by parent (source sentence)
    es_dev["half"] = np.where(es_dev["parent_source_id"].map(lambda g: unit("pdev:" + g)) < 0.5, "VALIDATION", "CALIBRATION")
    parts = {"VALIDATION": [], "CALIBRATION": []}
    en = paws[("en", "validation")].set_index("id")
    for half in parts:
        h = es_dev[es_dev["half"] == half]
        parts[half].append(h)
        pos = h[h["label"] == 1]
        parts[half].append(pd.DataFrame(rule_negatives(pos, rng, f"pawsx_es_dev_{half.lower()}")))
        tr = h.drop_duplicates("paws_id")
        tr = tr[tr["paws_id"].isin(en.index)]
        e1 = en.loc[tr["paws_id"], "sentence1"].map(norm_text).values
        e2 = en.loc[tr["paws_id"], "sentence2"].map(norm_text).values
        parts[half].append(tr.assign(pair_id=tr["pair_id"] + ":en", text_b=e1, label=1.0, pair_class="TRANSLATED_PARAPHRASE", lang_b="en", dataset="pawsx_dev_es_en"))
        neg = tr[tr["label"] == 0]
        parts[half].append(neg.assign(pair_id=neg["pair_id"] + ":en_neg", text_b=en.loc[neg["paws_id"], "sentence2"].map(norm_text).values, label=0.0,
                                      pair_class="TRANSLATED_LEXICAL_NEGATIVE", lang_b="en", dataset="pawsx_dev_es_en"))
        del e2
    val = pd.concat(parts["VALIDATION"], ignore_index=True)
    cal = pd.concat(parts["CALIBRATION"], ignore_index=True)
    # translated OOD: es <-> de / fr of the same dev ids (language pairs never trained); negatives = other ids, same language
    tood = []
    base = es_dev.drop_duplicates("paws_id")
    for lang in ("de", "fr"):
        o = paws[(lang, "validation")].set_index("id")
        b = base[base["paws_id"].isin(o.index)]
        tood.append(b.assign(pair_id=b["pair_id"] + f":{lang}", text_b=o.loc[b["paws_id"], "sentence1"].map(norm_text).values, label=1.0,
                             pair_class="TRANSLATED_PARAPHRASE", lang_b=lang, dataset=f"pawsx_dev_es_{lang}"))
        bn = b[b["label"] == 0]
        tood.append(bn.assign(pair_id=bn["pair_id"] + f":{lang}_neg", text_b=o.loc[bn["paws_id"], "sentence2"].map(norm_text).values, label=0.0,
                              pair_class="TRANSLATED_LEXICAL_NEGATIVE", lang_b=lang, dataset=f"pawsx_dev_es_{lang}"))
    tood = pd.concat(tood, ignore_index=True)
    # TRANSLATED_OOD shares source sentences with VALIDATION / CALIBRATION (same dev ids): evaluation-only family, never trained
    # hard-negative OOD: STS-es
    st = pd.read_parquet(RAW / "stses_test.parquet")
    st = pd.DataFrame({"pair_id": [f"stses:{i}" for i in range(len(st))], "text_a": st["sentence1"].map(norm_text), "text_b": st["sentence2"].map(norm_text),
                       "score": st["score"].astype(float)})
    st["label"] = np.where(st["score"] >= 4, 1.0, np.where(st["score"] <= 1, 0.0, np.nan))
    st["pair_class"] = np.where(st["label"] == 1, "STS_HIGH", np.where(st["label"] == 0, "SAME_TOPIC_NEGATIVE", "STS_GRADED_ONLY"))
    st["lang_b"], st["dataset"] = "es", "stses"
    st["parent_source_id"] = "stses_src:" + st["text_a"].map(key).str[:16]
    st["lineage"] = st["parent_source_id"]
    anchors = st.drop_duplicates("text_a").assign(label=1.0)
    hn = pd.DataFrame(rule_negatives(anchors, rng, "stses"))
    hood = pd.concat([st, hn], ignore_index=True)
    # FINAL: Sushi (human, CC0); sentence pairs + document pairs
    sd = pd.read_csv(RAW / "sushi" / "sushi_dataset.txt", sep="\t", header=None, names=["a", "b", "label"], quoting=3, on_bad_lines="skip", encoding="utf-8")
    sd = sd[sd["a"].notna() & sd["b"].notna()]
    fin = pd.DataFrame({"pair_id": [f"sushi:{i}" for i in range(len(sd))], "text_a": sd["a"].map(norm_text), "text_b": sd["b"].map(norm_text),
                        "label": sd["label"].astype(float), "pair_class": np.where(sd["label"] == 1, "HUMAN_PARAPHRASE", "SAME_TOPIC_OR_VOCAB_NEGATIVE"),
                        "lang_b": "es", "dataset": "sushi_sentences", "parent_source_id": "sushi:article", "lineage": "sushi:article"})
    docs = {fn: (RAW / "sushi" / fn).read_text(encoding="utf-8", errors="replace") for fn in SUSHI_FILES if fn not in ("sushi_dataset.txt",)}
    drows = []
    for fn, txt in docs.items():
        if fn == "sushi0.txt":
            continue
        lab = 1.0 if ("high" in fn or "low" in fn) else 0.0
        drows.append({"pair_id": f"sushi_doc:{fn}", "text_a": norm_text(docs["sushi0.txt"]), "text_b": norm_text(txt), "label": lab,
                      "pair_class": "HUMAN_PARAPHRASE_DOC" if lab else "SAME_TOPIC_DOC", "lang_b": "es", "dataset": "sushi_documents",
                      "parent_source_id": "sushi:article", "lineage": "sushi:article", "doc_level": True})
    fin = pd.concat([fin, pd.DataFrame(drows)], ignore_index=True)
    # TRAIN: Claude pairs (training only) + PAWS-X es TRAIN
    cl = pd.read_parquet(PAIRS / "claude_pairs.parquet") if (PAIRS / "claude_pairs.parquet").exists() else pd.DataFrame()
    if len(cl):
        from f0082_common import NEGATIVE, POSITIVE

        cl["label"] = cl["pair_class"].map(lambda c: POSITIVE.get(c, 0.0 if c in NEGATIVE else np.nan))
    else:
        log("WARNING: no Claude pairs yet")
    train = pd.concat([es_train, cl], ignore_index=True)
    n_train0 = len(train)
    # ------------------------------------------------ dedup inside TRAIN
    train["k"] = train["text_a"].map(key) + "|" + train["text_b"].map(key)
    exact_within = int(train["k"].duplicated().sum())
    train = train.drop_duplicates("k").reset_index(drop=True)
    # ------------------------------------------------ leakage: drop TRAIN rows touching any evaluation sentence (exact or near)
    evals = {"validation": val, "calibration": cal, "translated_ood": tood, "hard_negative_ood": hood, "final": fin, "regression_paws_test": es_test}
    ev_keys = set()
    ev_texts = []
    for f_ in evals.values():
        for c in ("text_a", "text_b"):
            ev_keys |= set(f_[c].map(key))
            ev_texts += f_[c].tolist()
    ev_texts = list(dict.fromkeys(ev_texts))
    ex = train["text_a"].map(key).isin(ev_keys) | train["text_b"].map(key).isin(ev_keys)
    exact_vs_eval = int(ex.sum())
    train = train[~ex].reset_index(drop=True)
    na = near_hits(ev_texts, train["text_a"].tolist())
    nb = near_hits(ev_texts, train["text_b"].tolist())
    near = sorted(na | nb)
    train = train.drop(index=near).reset_index(drop=True)
    # parent: a TRAIN parent may not appear in any evaluation split
    ev_par = set().union(*[set(f_["parent_source_id"].dropna()) for f_ in evals.values()])
    pdrop = train["parent_source_id"].isin(ev_par)
    train = train[~pdrop].reset_index(drop=True)
    # validation vs calibration vs final: parents disjoint by construction; check exact text overlap with FINAL
    fin_keys = set(fin["text_a"].map(key)) | set(fin["text_b"].map(key))
    leak = {"TRAIN_vs_eval_exact": int((train["text_a"].map(key).isin(ev_keys) | train["text_b"].map(key).isin(ev_keys)).sum()),
            "TRAIN_vs_eval_near": len(near_hits(ev_texts, train["text_a"].tolist()) | near_hits(ev_texts, train["text_b"].tolist())),
            "TRAIN_vs_eval_parent": int(train["parent_source_id"].isin(ev_par).sum()),
            "TRAIN_vs_eval_lineage": int(train["lineage"].isin(set().union(*[set(f_["lineage"].dropna()) for f_ in evals.values()])).sum()),
            "VALIDATION_vs_CALIBRATION_parent": len(set(val["parent_source_id"]) & set(cal["parent_source_id"])),
            "FINAL_vs_other_eval_exact": len(fin_keys & set().union(*[set(f_["text_a"].map(key)) | set(f_["text_b"].map(key))
                                                                      for k, f_ in evals.items() if k != "final"])),
            "CLAUDE_rows_outside_TRAIN": 0}
    leak["CROSS_SPLIT_LEAKAGE"] = leak["TRAIN_vs_eval_exact"] + leak["TRAIN_vs_eval_near"] + leak["FINAL_vs_other_eval_exact"] + leak["VALIDATION_vs_CALIBRATION_parent"]
    leak["PARENT_LEAKAGE"] = leak["TRAIN_vs_eval_parent"] + leak["VALIDATION_vs_CALIBRATION_parent"]
    leak["SOURCE_LEAKAGE"] = leak["TRAIN_vs_eval_parent"]
    leak["LINEAGE_LEAKAGE"] = leak["TRAIN_vs_eval_lineage"]
    leak["result"] = "PASS" if all(v == 0 for k, v in leak.items() if k != "result") else "FAIL"
    dedup = {"train_rows_before": n_train0, "exact_within_train_removed": exact_within, "exact_vs_eval_removed": exact_vs_eval,
             "near_vs_eval_removed": len(near), "parent_vs_eval_removed": int(pdrop.sum()), "train_rows_after": int(len(train))}
    log("dedup " + json.dumps(dedup))
    log("leakage " + json.dumps(leak))
    if leak["result"] != "PASS":
        write_json(MANI / "f008_2_leakage_FAIL.json", {"leak": leak, "dedup": dedup})
        raise SystemExit("STOP_BEFORE_TRAINING: leakage")
    out = {"train": train.drop(columns=["k"]), "validation": val, "calibration": cal, "translated_ood": tood, "hard_negative_ood": hood,
           "final_external_holdout": fin, "regression_paws_test": es_test}
    for k, f_ in out.items():
        f_.to_parquet(SPLITS / f"f008_2_{k}.parquet", index=False)

    def summary(f_):
        return {"pairs": int(len(f_)), "by_class": f_["pair_class"].value_counts().to_dict(), "by_dataset": f_["dataset"].value_counts().to_dict(),
                "positives": int((f_["label"] == 1).sum()), "negatives": int((f_["label"] == 0).sum()), "parents": int(f_["parent_source_id"].nunique()),
                "file_sha256": sha256_file(SPLITS / f"f008_2_{[k for k, v in out.items() if v is f_][0]}.parquet")}

    common = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "downloads_sha256": dl, "dedup": dedup, "leakage": leak}
    sm = {k: summary(v) for k, v in out.items()}
    for k in out:
        write_json(MANI / f"f008_2_{k}.json", {"name": f"F008_2_{k.upper()}", **common, **sm[k]})
    write_json(man_path, {"name": "F008_2_FINAL_EXTERNAL_HOLDOUT", **common, **sm["final_external_holdout"], "LOCKED": True,
                          "rule": "never used for training / selection / calibration; evaluated ONCE after F008_2_MODEL_LOCK"})
    write_json(REPO / "reports" / "f008_2" / "split_report.json", {**common, "splits": sm})
    log("splits: " + json.dumps({k: v["pairs"] for k, v in sm.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
