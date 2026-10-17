"""Choose the Spanish and academic sampling weights on VALIDATION V2 only.

A fast proxy detector (hashed char/word n-grams + logistic SGD) is trained on a weighted sample of
TRAIN for each candidate; the weight maximising mean(macro F1 all, Spanish, academic) on
validation_v2 wins (Spanish first, then academic with the chosen Spanish weight). Test is never read.

    python scripts/v3_select_weights.py --out /content/drive/MyDrive/turniting/v3/manifests/weight_selection.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.linear_model import SGDClassifier
from scipy.sparse import hstack

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from turniting_train import adapters_v2 as A  # noqa: E402
from turniting_train.canon import canonicalize  # noqa: E402
from turniting_train.common import CONFIG_DIR, load_yaml, write_json  # noqa: E402
from turniting_train.metrics import binary_metrics  # noqa: E402
from turniting_train.sampling import weighted_sample  # noqa: E402
from v3_train import META, read_split, row_weights  # noqa: E402

CHAR = HashingVectorizer(analyzer="char_wb", ngram_range=(2, 4), n_features=2**20, alternate_sign=False, norm="l2")
WORD = HashingVectorizer(analyzer="word", ngram_range=(1, 2), n_features=2**19, alternate_sign=False, norm="l2")


def feats(texts):
    texts = [canonicalize(t)[:3000] for t in texts]
    return hstack([CHAR.transform(texts), WORD.transform(texts)]).tocsr()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", default="/content/v3work/master_v2")
    ap.add_argument("--eval-sets", default="/content/v3work/eval_sets_v2.parquet")
    ap.add_argument("--out", required=True)
    ap.add_argument("--docs", type=int, default=80000)
    args = ap.parse_args()
    cfg = load_yaml(CONFIG_DIR / "v3.yaml")["train"]
    sp = cfg["sampling"]
    master = Path(args.master)
    meta = read_split(master, "train", META)
    meta = meta[meta["fine_label"] != A.UNKNOWN].reset_index(drop=True)
    ev = pd.read_parquet(args.eval_sets)
    vids = ev.loc[ev["eval_set"] == "validation_v2", "id"].tolist()
    val = read_split(master, "validation", ["id", "text_original", "fine_label", "language", "domain"], ids=vids)
    Xv = feats(val["text_original"].tolist())
    yv = (val["fine_label"] != A.HUMAN).astype(int).values
    es, aca = (val["language"] == "es").values, (val["domain"] == "academic").values
    text_cache: dict = {}

    def run(es_w, aca_w):
        t0 = time.time()
        w = row_weights(meta, sp, es_w, aca_w)
        docs = weighted_sample(meta, w, args.docs, cfg["seed"])
        need = [i for i in docs["id"] if i not in text_cache]
        if need:
            t = read_split(master, "train", ["id", "text_original"], ids=need)
            text_cache.update(zip(t["id"], t["text_original"]))
        X = feats([text_cache[i] for i in docs["id"]])
        y = (docs["fine_label"] != A.HUMAN).astype(int).values
        clf = SGDClassifier(loss="log_loss", alpha=2e-6, max_iter=15, tol=None, random_state=cfg["seed"]).fit(X, y)
        p = clf.predict_proba(Xv)[:, 1]
        m = [binary_metrics(yv, p)["macro_f1"], binary_metrics(yv[es], p[es])["macro_f1"],
             binary_metrics(yv[aca], p[aca])["macro_f1"]]
        r = {"spanish_weight": es_w, "academic_weight": aca_w, "primary": float(np.mean(m)), "macro_f1": m[0],
             "spanish_macro_f1": m[1], "academic_macro_f1": m[2], "seconds": round(time.time() - t0, 1)}
        print(json.dumps(r), flush=True)
        return r

    runs = [run(e, sp["academic_weight"]) for e in sp["spanish_weight_candidates"]]
    best_es = max(runs, key=lambda r: r["primary"])["spanish_weight"]
    runs += [run(best_es, a) for a in sp["academic_weight_candidates"] if a != sp["academic_weight"]]
    best = max(runs, key=lambda r: r["primary"])
    write_json(Path(args.out), {"spanish_weight": best["spanish_weight"], "academic_weight": best["academic_weight"],
                                "selected_on": "validation_v2 (proxy hashed n-gram logistic detector)", "runs": runs})
    print("selected", best)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
