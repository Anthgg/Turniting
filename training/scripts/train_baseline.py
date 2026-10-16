"""Baselines: TF-IDF+LogReg, TF-IDF+LinearSVM (+sigmoid calibration), stylometric GBM,
TF-IDF+stylometric ensemble (LogReg). Also SPANISH_TRAIN_WEIGHT selection and
leave-one-dataset-out (LODO) evaluation.

    python scripts/train_baseline.py [--skip-lodo] [--skip-tuning]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import scipy.sparse as sp
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction.text import HashingVectorizer, TfidfTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FeatureUnion
from sklearn.preprocessing import StandardScaler
from sklearn.svm import LinearSVC

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import (  # noqa: E402
    CONFIG_DIR, DATASET_VERSION, MODELS_DIR, REPORTS_DIR, git_commit, hardware_info, library_versions,
    load_yaml, read_json, set_seed, utc_now, write_json,
)
from turniting_train.data import add_flags, load_split  # noqa: E402
from turniting_train.evalsets import build_eval_sets, load_eval_frame  # noqa: E402
from turniting_train.features import FEATURE_NAMES, stylometric_matrix  # noqa: E402
from turniting_train.textvec import TextVectorizer  # noqa: E402
from turniting_train.metrics import binary_metrics, grouped_metrics, length_bin, select_thresholds  # noqa: E402
from turniting_train.sampling import row_weights, usage_table, weighted_sample  # noqa: E402
from turniting_train.splits import TRAIN  # noqa: E402

OUT = MODELS_DIR / "baseline"
EVAL_NAMES = ["validation_large", "validation", "validation_spanish", "validation_academic", "test_large",
              "test", "test_spanish", "test_academic", "ood", "adversarial", "adversarial_clean_reference",
              "unseen_generator", "unseen_domain"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def sample_train(meta: pd.DataFrame, cfg: dict, n: int, seed: int, spanish_weight=None) -> pd.DataFrame:
    w = row_weights(meta, cfg["sampling"], spanish_weight=spanish_weight)
    cap = cfg["sampling"]["adversarial_train_fraction_cap"]
    adv = meta["is_adversarial"].values
    if adv.any():  # rescale adversarial mass to the cap
        frac = w[adv].sum() / w.sum()
        if frac > cap:
            w[adv] *= cap * (1 - frac) / (frac * (1 - cap))
    return weighted_sample(meta, w, n, seed), w


def score(model, X):
    if hasattr(model, "predict_proba"):
        return model.predict_proba(X)[:, 1]
    return 1 / (1 + np.exp(-model.decision_function(X)))


def evaluate_sets(name, predict_fn, frames, thr, report):
    res = {}
    for set_name, df in frames.items():
        s = predict_fn(df)
        df = df.assign(score=s, length_bin=length_bin(df["n_words"]).values)
        m = binary_metrics(df["label"], s, thr)
        m["groups"] = grouped_metrics(df, "score", thr, ["dataset", "language", "domain", "generator_family",
                                                         "attack", "length_bin"])
        if set_name.startswith("test"):
            m["spanish"] = binary_metrics(df.loc[df["is_spanish"], "label"], df.loc[df["is_spanish"], "score"], thr)
            m["academic"] = binary_metrics(df.loc[df["is_academic"], "label"], df.loc[df["is_academic"], "score"], thr)
        res[set_name] = m
        df[["id", "label", "score"]].to_parquet(OUT / name / f"scores_{set_name}.parquet", index=False)
    report[name] = res
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-lodo", action="store_true")
    ap.add_argument("--skip-tuning", action="store_true")
    args = ap.parse_args()
    cfg = load_yaml(CONFIG_DIR / "training.yaml")
    bcfg = cfg["baseline"]
    seed = cfg["seed"]
    set_seed(seed)
    t_start = time.time()
    OUT.mkdir(parents=True, exist_ok=True)

    log("loading train metadata")
    meta = add_flags(load_split(TRAIN))
    log(f"train pool rows={len(meta):,}")
    eval_sets = build_eval_sets(cfg, seed)
    frames = load_eval_frame(eval_sets, EVAL_NAMES)
    for k_, v_ in frames.items():
        v_.attrs["set"] = k_
    log("eval sets: " + ", ".join(f"{k}={len(v)}" for k, v in frames.items()))

    # ---------------------------------------------------------- SPANISH_TRAIN_WEIGHT selection
    tuning = {}
    chosen_es = cfg["sampling"]["language_weights"]["es"]
    if args.skip_tuning:
        prev = read_json(OUT / "spanish_weight_selection.json", {})
        chosen_es, tuning = prev.get("selected", chosen_es), prev.get("candidates", {})
    if not args.skip_tuning:
        val = frames["validation_large"]
        for cand in cfg["sampling"]["spanish_weight_candidates"]:
            sample, _ = sample_train(meta, cfg, bcfg["tune_rows"], seed, spanish_weight=cand)
            texts = load_split(TRAIN, ["id", "text", "label"], ids=sample["id"])
            vec = TextVectorizer(bcfg)
            X = vec.fit_transform(texts["text"].tolist())
            model = LogisticRegression(C=bcfg["lr_C"], solver="saga", max_iter=bcfg["max_iter"], tol=1e-3).fit(
                X, texts["label"].values)
            s = score(model, vec.transform(val["text"].tolist()))
            g = binary_metrics(val["label"], s)["macro_f1"]
            es = val["is_spanish"].values
            e = binary_metrics(val["label"][es], s[es])["macro_f1"]
            tuning[str(cand)] = {"val_macro_f1": g, "val_spanish_macro_f1": e, "objective": 0.5 * g + 0.5 * e,
                                 "spanish_share_in_sample": float((sample["language"] == "es").mean())}
            log(f"  es weight {cand}: global {g:.4f} spanish {e:.4f}")
        chosen_es = float(max(tuning, key=lambda k: tuning[k]["objective"]))
        log(f"SPANISH_TRAIN_WEIGHT = {chosen_es}")
    write_json(OUT / "spanish_weight_selection.json", {"candidates": tuning, "selected": chosen_es,
                                                       "criterion": "max 0.5*val_macro_f1 + 0.5*val_spanish_macro_f1 (VALIDATION, TF-IDF+LR proxy)"})

    # ---------------------------------------------------------- final training sample
    sample, weights = sample_train(meta, cfg, bcfg["train_rows"], seed, spanish_weight=chosen_es)
    usage = usage_table(meta, sample, weights)
    usage.to_csv(OUT / "train_usage.csv", index=False)
    train = load_split(TRAIN, ["id", "text", "label", "language", "domain", "dataset"], ids=sample["id"])
    train = add_flags(train)
    log(f"baseline train rows={len(train):,} spanish={int(train['is_spanish'].sum()):,} "
        f"machine={int(train['label'].sum()):,}")
    y = train["label"].values

    vec = TextVectorizer(bcfg)
    t0 = time.time()
    X = vec.fit_transform(train["text"].tolist())
    log(f"tfidf {X.shape} nnz={X.nnz:,} ({time.time() - t0:.0f}s)")
    style_tr = stylometric_matrix(train["text"].tolist())
    scaler = StandardScaler().fit(style_tr)

    def feats(df):
        return vec.transform(df["text"].tolist()), stylometric_matrix(df["text"].tolist())

    def ens_X(a, b):
        """Stacking features: base-model log-odds + standardized stylometric features."""
        def logit(p):
            p = np.clip(p, 1e-6, 1 - 1e-6)
            return np.log(p / (1 - p))
        return np.column_stack([logit(lr.predict_proba(a)[:, 1]), svm.decision_function(a),
                                logit(gbm.predict_proba(b)[:, 1]), scaler.transform(b)])

    report, timings = {}, {}
    # 1) TF-IDF + LR (saga keeps float32: no dense/float64 copy of the matrix)
    t0 = time.time()
    lr = LogisticRegression(C=bcfg["lr_C"], solver="saga", max_iter=bcfg["max_iter"], tol=1e-3).fit(X, y)
    timings["tfidf_logreg"] = time.time() - t0
    log(f"logreg fitted ({timings['tfidf_logreg']:.0f}s)")
    # 2) TF-IDF + LinearSVM (calibrated afterwards on validation with a sigmoid)
    t0 = time.time()
    svm = LinearSVC(C=bcfg["svm_C"], dual=True, max_iter=2000).fit(X, y)
    timings["tfidf_svm"] = time.time() - t0
    log(f"svm fitted ({timings['tfidf_svm']:.0f}s)")
    # 3) stylometric
    t0 = time.time()
    gbm = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, random_state=seed).fit(style_tr, y)
    timings["stylometric_gbm"] = time.time() - t0
    # 4) ensemble: stacked LogReg over TF-IDF models + stylometric features, fitted on a TRAIN
    #    sample disjoint from the base-model sample (no validation/test involvement)
    t0 = time.time()
    del X
    stack_pool = meta[~meta["id"].isin(set(sample["id"]))]
    stack_ids, _ = sample_train(stack_pool, cfg, bcfg["stack_rows"], seed + 7, spanish_weight=chosen_es)
    stack = load_split(TRAIN, ["id", "text", "label"], ids=stack_ids["id"])
    sa, sb = vec.transform(stack["text"].tolist()), stylometric_matrix(stack["text"].tolist())
    ens = LogisticRegression(C=1.0, max_iter=1000).fit(ens_X(sa, sb), stack["label"].values)
    del sa, sb
    timings["ensemble_tfidf_stylometric"] = time.time() - t0
    log(f"ensemble fitted on {len(stack):,} disjoint TRAIN rows")

    # ---------------------------------------------------------- scoring (features built once per set)
    scores: dict[str, dict[str, np.ndarray]] = {k: {} for k in timings}
    svm_cal = None
    order = ["validation_large"] + [n for n in EVAL_NAMES if n != "validation_large"]
    for set_name in order:
        df = frames[set_name]
        a, b = feats(df)
        if svm_cal is None:  # posterior calibration of the SVM on VALIDATION
            svm_cal = CalibratedClassifierCV(svm, method="sigmoid", cv="prefit").fit(a, df["label"].values)
        scores["tfidf_logreg"][set_name] = lr.predict_proba(a)[:, 1]
        scores["tfidf_svm"][set_name] = svm_cal.predict_proba(a)[:, 1]
        scores["stylometric_gbm"][set_name] = gbm.predict_proba(b)[:, 1]
        scores["ensemble_tfidf_stylometric"][set_name] = ens.predict_proba(ens_X(a, b))[:, 1]
        del a, b
        log(f"  scored {set_name} ({len(df)})")
    models = {"tfidf_logreg": lr, "tfidf_svm": svm_cal, "stylometric_gbm": gbm, "ensemble_tfidf_stylometric": ens}

    summary = {}
    for name, model in models.items():
        (OUT / name).mkdir(parents=True, exist_ok=True)
        val_df = frames["validation_large"]
        thr_info = select_thresholds(val_df["label"].values, scores[name]["validation_large"],
                                     cfg["calibration"]["low_fpr_max"], cfg["calibration"]["high_precision_target"])
        thr = thr_info["BALANCED"]["threshold"]
        res = evaluate_sets(name, lambda df, _n=name: scores[_n][df.attrs["set"]], frames, thr, report)
        summary[name] = {"threshold": thr, "thresholds": thr_info, "train_seconds": round(timings[name], 1),
                         "validation": {k: res["validation_large"].get(k) for k in ("macro_f1", "f1", "fpr")},
                         "validation_spanish_macro_f1": res["validation_spanish"].get("macro_f1"),
                         "validation_academic_macro_f1": res["validation_academic"].get("macro_f1")}
        joblib.dump({"model": model, "vectorizer": vec if name != "stylometric_gbm" else None,
                     "scaler": scaler if name == "ensemble_tfidf_stylometric" else None,
                     "base_models": {"lr": lr, "svm": svm, "gbm": gbm} if name == "ensemble_tfidf_stylometric" else None,
                     "kind": name, "threshold": thr, "thresholds": thr_info, "feature_names": FEATURE_NAMES,
                     "max_chars": bcfg["max_chars"]}, OUT / name / "model.joblib", compress=3)
        write_json(OUT / name / "metrics.json", res)
        write_json(OUT / name / "config.json", {"baseline": bcfg, "sampling": cfg["sampling"],
                                                 "spanish_train_weight": chosen_es, "seed": seed})
        log(f"{name}: val macroF1={res['validation_large']['macro_f1']:.4f} "
            f"test macroF1={res['test_large']['macro_f1']:.4f} ES={res['test_spanish']['macro_f1']:.4f}")

    # best baseline: VALIDATION only (global + Spanish + academic macro F1)
    def val_obj(k):
        s = summary[k]
        return (s["validation"]["macro_f1"] + s["validation_spanish_macro_f1"] + s["validation_academic_macro_f1"]) / 3
    best = max(summary, key=val_obj)
    log(f"best baseline (validation objective): {best}")
    best_dir = OUT / "best"
    if best_dir.exists():
        import shutil
        shutil.rmtree(best_dir)
    import shutil
    shutil.copytree(OUT / best, best_dir)
    write_json(best_dir / "model_manifest.json", {
        "modelVersion": "TURNITING_AI_V1-baseline", "name": best, "datasetVersion": DATASET_VERSION,
        "selectedBy": "mean(validation macro F1, validation Spanish macro F1, validation academic macro F1)",
        "threshold": summary[best]["threshold"], "thresholds": summary[best]["thresholds"],
        "gitCommit": git_commit(), "createdAt": utc_now(), "labels": {"0": "HUMAN", "1": "MACHINE"},
    })

    # ---------------------------------------------------------- LODO
    lodo = read_json(OUT / "lodo_metrics.json", {}) if args.skip_lodo else {}
    if not args.skip_lodo:
        test_frames = load_eval_frame(eval_sets, ["test_large", "ood"])
        held = pd.concat([test_frames["test_large"], test_frames["ood"]])
        for ds in sorted(meta["dataset"].astype(str).unique()):
            target = held[held["dataset"] == ds]
            if len(target) < 200 or target["label"].nunique() < 2:
                continue
            pool = meta[meta["dataset"] != ds]
            s_, _ = sample_train(pool, cfg, bcfg["lodo_train_rows"], seed, spanish_weight=chosen_es)
            tx = load_split(TRAIN, ["id", "text", "label"], ids=s_["id"])
            v = TextVectorizer(bcfg)
            m = LogisticRegression(C=bcfg["lr_C"], solver="saga", max_iter=bcfg["max_iter"], tol=1e-3).fit(
                v.fit_transform(tx["text"].tolist()), tx["label"].values)
            sc = score(m, v.transform(target["text"].tolist()))
            # threshold from in-distribution validation of the LODO model
            vv = frames["validation_large"]
            vv = vv[vv["dataset"] != ds]
            thr = select_thresholds(vv["label"].values, score(m, v.transform(vv["text"].tolist())))["BALANCED"]["threshold"]
            lodo[ds] = binary_metrics(target["label"], sc, thr)
            log(f"  LODO {ds}: macroF1={lodo[ds]['macro_f1']:.4f} f1={lodo[ds]['f1']:.4f} n={len(target)}")
        write_json(OUT / "lodo_metrics.json", lodo)

    write_json(REPORTS_DIR / "baseline_metrics.json", {
        "createdAt": utc_now(), "gitCommit": git_commit(), "datasetVersion": DATASET_VERSION,
        "hardware": hardware_info(), "versions": library_versions(), "seed": seed,
        "spanish_train_weight": chosen_es, "spanish_weight_selection": tuning,
        "train_rows": int(len(train)), "usage": usage.to_dict("records"),
        "summary": summary, "best": best, "lodo": lodo, "metrics": report,
        "duration_seconds": round(time.time() - t_start, 1),
    })
    log(f"done in {time.time() - t_start:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
