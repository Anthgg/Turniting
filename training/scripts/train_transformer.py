"""Fine-tune the multilingual transformer detector (GLOBAL or SPANISH_ACADEMIC refinement).

    python scripts/train_transformer.py --smoke
    python scripts/train_transformer.py --mode global
    python scripts/train_transformer.py --mode refine --init-from checkpoints/<global_exp>/best
    python scripts/train_transformer.py --mode global --resume-from-checkpoint checkpoints/<exp>/last

Checkpoints: checkpoints/<experiment_id>/{best,last}. Early stopping on VALIDATION macro F1
(patience configurable); TEST is never read here.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import psutil
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import (  # noqa: E402
    CHECKPOINT_DIR, CONFIG_DIR, DATASET_VERSION, MANIFEST_DIR, MODELS_DIR, ensure_disk, git_commit, hardware_info,
    keep_system_awake,
    library_versions, load_yaml, read_json, set_seed, utc_now, write_json,
)
from turniting_train.data import add_flags, load_split  # noqa: E402
from turniting_train.evalsets import build_eval_sets, load_eval_frame  # noqa: E402
from turniting_train.metrics import binary_metrics  # noqa: E402
from turniting_train.sampling import row_weights, weighted_sample  # noqa: E402
from turniting_train.splits import TRAIN  # noqa: E402
from turniting_train.transformer import (  # noqa: E402
    aggregate, collate, freeze, make_windows, resolve_model, score_windows, sigmoid,
)

VAL_SETS = ["validation", "validation_spanish", "validation_academic"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def build_train_windows(tokenizer, cfg, tcfg, n_windows, seed, mode, smoke):
    meta = add_flags(load_split(TRAIN))
    sp = cfg["sampling"]
    es_sel = read_json(MODELS_DIR / "baseline" / "spanish_weight_selection.json", {})
    es_w = es_sel.get("selected", sp["language_weights"]["es"])
    w = row_weights(meta, sp, spanish_weight=es_w)
    adv = meta["is_adversarial"].values
    frac = w[adv].sum() / w.sum() if adv.any() else 0
    cap = sp["adversarial_train_fraction_cap"]
    if frac > cap:
        w[adv] *= cap * (1 - frac) / (frac * (1 - cap))
    n_docs = int(n_windows / 1.25)
    if mode == "refine":
        rcfg = cfg["refinement"]
        target = (meta["is_spanish"] | meta["is_academic"]).values
        n_t = int(n_docs * rcfg["target_fraction"])
        a = weighted_sample(meta[target], w[target], n_t, seed)
        b = weighted_sample(meta[~target], w[~target], n_docs - n_t, seed + 1)
        docs = pd.concat([a, b])
    else:
        docs = weighted_sample(meta, w, n_docs, seed)
    texts = load_split(TRAIN, ["id", "text", "label"], ids=docs["id"]).set_index("id").loc[docs["id"]]
    rng = random.Random(seed)
    windows, labels, doc_ids = [], [], []
    for i, (doc_id, row) in enumerate(texts.iterrows()):
        ws = make_windows(tokenizer, row["text"], i, tcfg["max_length"], tcfg["stride"], tcfg["max_windows_per_doc"])
        if len(ws) > 2:  # keep the first window and one random other: diversity without long-doc dominance
            ws = [ws[0], rng.choice(ws[1:])]
        for wdw in ws:
            windows.append(wdw)
            labels.append(int(row["label"]))
            doc_ids.append(doc_id)
        if len(windows) >= n_windows:
            break
    usage = docs.assign(used=docs["id"].isin(set(doc_ids)))
    usage = usage[usage["used"]]
    return windows, labels, usage, es_w


def evaluate_docs(model, tokenizer, frame, tcfg, method="mean"):
    wl = score_windows(model, tokenizer, frame["text"].tolist(), tcfg["max_length"], tcfg["stride"],
                       tcfg["max_windows_per_doc"], batch_size=tcfg["batch_size"] * 2)
    doc_logit = aggregate(wl, method)
    p = sigmoid(doc_logit)
    m = binary_metrics(frame["label"].values, p, 0.5)
    y = frame["label"].values
    pc = np.clip(p, 1e-7, 1 - 1e-7)
    m["loss"] = float(-np.mean(y * np.log(pc) + (1 - y) * np.log(1 - pc)))
    return m, wl


def save_checkpoint(path: Path, model, tokenizer, extra: dict | None = None, optimizer=None, scheduler=None,
                    trainable_only: bool = False):
    """best: full weights (servable). last: trainable params + optimizer/scheduler/RNG only
    (frozen weights are re-read from `extra['init']` on resume), which keeps `last` small."""
    ensure_disk(0.4 if trainable_only else 1.5, f"save checkpoint {path}")
    tmp = path.with_name(path.name + ".tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    if trainable_only:
        names = {n for n, p in model.named_parameters() if p.requires_grad}
        torch.save({k: v for k, v in model.state_dict().items() if k in names}, tmp / "trainable_state.pt")
        model.config.save_pretrained(tmp)
    else:
        model.save_pretrained(tmp, safe_serialization=True)
    tokenizer.save_pretrained(tmp)
    if optimizer is not None:
        torch.save({"optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(),
                    "rng": {"torch": torch.get_rng_state(), "numpy": np.random.get_state(),
                            "python": random.getstate()}}, tmp / "trainer_state.pt")
    write_json(tmp / "checkpoint_info.json", extra or {})
    if path.exists():
        shutil.rmtree(path)
    os.replace(tmp, path)


def dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) if path.exists() else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["global", "refine"], default="global")
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--init-from", help="checkpoint dir to start from (refine)")
    ap.add_argument("--resume-from-checkpoint", help="checkpoints/<exp>/last to resume")
    ap.add_argument("--experiment-id")
    ap.add_argument("--max-steps", type=int, help="stop after this many optimizer steps (resume tests)")
    ap.add_argument("--config", default=str(CONFIG_DIR / "training.yaml"),
                    help="configs/training.yaml (CPU profile) or configs/training_gpu.yaml (Colab/CUDA)")
    args = ap.parse_args()
    keep_system_awake()

    cfg = load_yaml(Path(args.config))
    tcfg = dict(cfg["transformer"])
    seed = cfg["seed"]
    set_seed(seed)
    torch.set_num_threads(tcfg["num_threads"])
    device = torch.device("cuda" if torch.cuda.is_available() else
                          "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
    if device.type == "cuda" and tcfg.get("cpu_profile", True):  # CPU profile on a GPU: use the full recipe
        tcfg.update(max_length=512, stride=128, trainable_top_layers=12, freeze_embeddings=False)
    use_amp = device.type == "cuda"
    amp_dtype = torch.bfloat16 if use_amp and torch.cuda.is_bf16_supported() else torch.float16
    scaler = torch.cuda.amp.GradScaler(enabled=use_amp and amp_dtype == torch.float16)

    if args.mode == "refine":
        rc = cfg["refinement"]
        n_windows, epochs, lr = rc["train_windows"], rc["epochs"], rc["learning_rate"]
    else:
        n_windows, epochs, lr = tcfg["train_windows"], tcfg["epochs"], tcfg["learning_rate"]
    val_docs_cap = None
    if args.smoke:
        n_windows, epochs, val_docs_cap = 1200, 1, 60
        tcfg["eval_every_steps"] = 20

    resume = Path(args.resume_from_checkpoint).resolve() if args.resume_from_checkpoint else None
    if resume:
        exp_dir = resume.parent
        exp_id = exp_dir.name
        state_info = read_json(resume / "checkpoint_info.json")
    else:
        tag = "mdeberta" if "mdeberta" in tcfg["model"] else tcfg["model"].split("/")[-1].split("-")[0]
        tag += "_es_acad" if args.mode == "refine" else ""
        tag += "_smoke" if args.smoke else ""
        exp_id = args.experiment_id or f"{datetime.now():%Y%m%d_%H%M}_{tag}_v1"
        exp_dir = CHECKPOINT_DIR / exp_id
        state_info = None
    exp_dir.mkdir(parents=True, exist_ok=True)
    log(f"experiment {exp_id} device={device} mode={args.mode} smoke={args.smoke}")

    from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

    base_path = resolve_model(tcfg["model"], tcfg["revision"])
    model_fallback_reason = None
    init = state_info["init"] if resume else (args.init_from or base_path)
    try:
        tokenizer = AutoTokenizer.from_pretrained(init)
        model = AutoModelForSequenceClassification.from_pretrained(
            init, num_labels=2, id2label={0: "HUMAN", 1: "MACHINE"}, label2id={"HUMAN": 0, "MACHINE": 1})
        if resume:
            missing = model.load_state_dict(torch.load(resume / "trainable_state.pt", weights_only=True), strict=False)
            log(f"resume: restored {len(torch.load(resume / 'trainable_state.pt', weights_only=True))} trainable tensors "
                f"(unexpected={len(missing.unexpected_keys)})")
    except Exception as exc:  # documented technical incompatibility only
        model_fallback_reason = f"{type(exc).__name__}: {exc}"
        log(f"mdeberta failed ({model_fallback_reason}); falling back to {tcfg['fallback_model']}")
        init = tcfg["fallback_model"]
        tokenizer = AutoTokenizer.from_pretrained(init)
        model = AutoModelForSequenceClassification.from_pretrained(init, num_labels=2)
    freeze_info = freeze(model, tcfg["freeze_embeddings"], tcfg["trainable_top_layers"])
    model.to(device)
    log(f"params {freeze_info}")

    eval_sets = build_eval_sets(cfg, seed)
    frames = load_eval_frame(eval_sets, VAL_SETS)
    val = frames["validation"]
    if val_docs_cap:
        val = val.groupby("label", group_keys=False).apply(lambda g: g.head(val_docs_cap // 2))
    t_build = time.time()
    windows, labels, usage, es_w = build_train_windows(tokenizer, cfg, tcfg, n_windows, seed, args.mode, args.smoke)
    log(f"train windows={len(windows):,} docs={len(usage):,} machine_share={np.mean(labels):.3f} "
        f"spanish_docs={int(usage['is_spanish'].sum())} academic_docs={int(usage['is_academic'].sum())} "
        f"({time.time() - t_build:.0f}s)")
    usage.groupby("dataset", observed=True).size().rename("used_train_docs").to_csv(exp_dir / "train_usage.csv")

    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=lr, weight_decay=tcfg["weight_decay"])
    bs, accum = tcfg["batch_size"], tcfg["gradient_accumulation"]
    steps_per_epoch = math.ceil(len(windows) / (bs * accum))
    total_steps = steps_per_epoch * epochs
    scheduler = get_linear_schedule_with_warmup(optimizer, int(total_steps * tcfg["warmup_ratio"]), total_steps)

    start_step, best_metric, bad_evals, history = 0, -1.0, 0, []
    if resume:
        st = torch.load(resume / "trainer_state.pt", weights_only=False)
        optimizer.load_state_dict(st["optimizer"])
        scheduler.load_state_dict(st["scheduler"])
        torch.set_rng_state(st["rng"]["torch"])
        np.random.set_state(st["rng"]["numpy"])
        random.setstate(st["rng"]["python"])
        start_step = state_info["step"]
        best_metric = state_info["best_metric"]
        bad_evals = state_info["bad_evals"]
        history = state_info["history"]
        log(f"resumed at step {start_step} (best {best_metric:.4f})")

    log_path = exp_dir / "train_log.jsonl"
    t0 = time.time()
    step = 0
    running, run_n = 0.0, 0
    stop = False
    order_rng = np.random.default_rng(seed)
    for epoch in range(epochs):
        perm = order_rng.permutation(len(windows))
        model.train()
        for b in range(steps_per_epoch):
            if step < start_step:  # fast-forward the deterministic data order on resume
                step += 1
                continue
            for a in range(accum):
                lo = (b * accum + a) * bs
                idx = perm[lo: lo + bs]
                if len(idx) == 0:
                    continue
                batch = collate([windows[i] for i in idx], tokenizer.pad_token_id, [labels[i] for i in idx])
                batch = {k: v.to(device) for k, v in batch.items()}
                with torch.autocast(device.type, dtype=amp_dtype, enabled=use_amp):
                    out = model(**batch)
                loss = out.loss.float() / accum
                if not torch.isfinite(loss):
                    raise RuntimeError(f"ABORT: non-finite loss at step {step}")
                scaler.scale(loss).backward()
                running += float(out.loss)
                run_n += 1
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            if step % 10 == 0:
                log(f"  step {step}/{total_steps} loss={running / max(run_n, 1):.4f} lr={scheduler.get_last_lr()[0]:.2e} "
                    f"rss={psutil.Process().memory_info().rss / 1e9:.1f}GB elapsed={time.time() - t0:.0f}s")
            last_step = step == total_steps
            if step % tcfg["eval_every_steps"] == 0 or last_step or (args.max_steps and step >= args.max_steps):
                t_eval = time.time()
                m, _ = evaluate_docs(model, tokenizer, val, tcfg)
                model.train()
                rec = {"step": step, "epoch": round(step / steps_per_epoch, 3), "train_loss": running / max(run_n, 1),
                       "val_loss": m["loss"], "val_macro_f1": m["macro_f1"], "val_f1": m["f1"], "val_fpr": m["fpr"],
                       "val_roc_auc": m["roc_auc"], "lr": scheduler.get_last_lr()[0],
                       "rss_gb": psutil.Process().memory_info().rss / 1e9,
                       "gpu_mem_gb": torch.cuda.max_memory_allocated() / 1e9 if device.type == "cuda" else None,
                       "elapsed_s": time.time() - t0, "eval_s": time.time() - t_eval}
                history.append(rec)
                with open(log_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(rec) + "\n")
                log(f"  EVAL step {step}: val macroF1={m['macro_f1']:.4f} loss={m['loss']:.4f} ({rec['eval_s']:.0f}s)")
                running, run_n = 0.0, 0
                improved = m["macro_f1"] > best_metric
                if improved:
                    best_metric, bad_evals = m["macro_f1"], 0
                    save_checkpoint(exp_dir / "best", model, tokenizer, {"step": step, "val_macro_f1": best_metric})
                else:
                    bad_evals += 1
                save_checkpoint(exp_dir / "last", model, tokenizer,
                                {"step": step, "best_metric": best_metric, "bad_evals": bad_evals, "history": history,
                                 "init": init, "mode": args.mode},
                                optimizer, scheduler, trainable_only=True)
                if bad_evals >= tcfg["early_stopping_patience"]:
                    log("early stopping (validation macro F1 did not improve)")
                    stop = True
                if args.max_steps and step >= args.max_steps:
                    log(f"max steps {args.max_steps} reached")
                    stop = True
            if stop:
                break
        if stop:
            break
    train_seconds = time.time() - t0

    # ------------------------------------------------ post-training on VALIDATION only
    best_dir = exp_dir / "best"
    model = AutoModelForSequenceClassification.from_pretrained(best_dir).to(device)
    full_val = pd.concat([frames[n] for n in VAL_SETS]).drop_duplicates("id")
    if val_docs_cap:
        full_val = full_val.head(val_docs_cap * 2)
    t_eval = time.time()
    wl = score_windows(model, tokenizer, full_val["text"].tolist(), tcfg["max_length"], tcfg["stride"],
                       tcfg["max_windows_per_doc"], batch_size=bs * 2)
    agg = {}
    for method in tcfg["aggregation_candidates"]:
        agg[method] = binary_metrics(full_val["label"].values, sigmoid(aggregate(wl, method)), 0.5)["macro_f1"]
    best_agg = max(agg, key=agg.get)
    log(f"aggregation on validation: {agg} -> {best_agg}")
    doc_logits = aggregate(wl, best_agg)
    pd.DataFrame({"id": full_val["id"].values, "label": full_val["label"].values, "logit": doc_logits,
                  "n_windows": [len(w) for w in wl]}).to_parquet(exp_dir / "validation_doc_logits.parquet", index=False)
    # overfitting check: same metrics on a slice of the training documents
    train_slice = load_split(TRAIN, ["id", "text", "label"], ids=usage["id"].head(400 if not args.smoke else 60))
    train_m, _ = evaluate_docs(model, tokenizer, train_slice, tcfg, best_agg)
    val_m = binary_metrics(full_val["label"].values, sigmoid(doc_logits), 0.5)
    yv = full_val["label"].values
    pv = np.clip(sigmoid(doc_logits), 1e-7, 1 - 1e-7)
    val_m["loss"] = float(-np.mean(yv * np.log(pv) + (1 - yv) * np.log(1 - pv)))
    write_json(best_dir / "inference_config.json", {
        "max_length": tcfg["max_length"], "stride": tcfg["stride"], "max_windows_per_doc": tcfg["max_windows_per_doc"],
        "aggregation": best_agg, "aggregation_validation_macro_f1": agg, "labels": {"0": "HUMAN", "1": "MACHINE"},
    })

    datasets_manifest = read_json(MANIFEST_DIR / "master_manifest.json", {})
    experiment = {
        "experimentId": exp_id,
        "timestamp": utc_now(),
        "gitCommit": git_commit(),
        "mode": args.mode,
        "smoke": args.smoke,
        "model": tcfg["model"] if not model_fallback_reason else tcfg["fallback_model"],
        "modelRevision": tcfg["revision"],
        "modelFallbackReason": model_fallback_reason,
        "initFrom": args.init_from,
        "tokenizer": tokenizer.__class__.__name__,
        "datasetVersion": DATASET_VERSION,
        "datasetHashes": {k: v["sha256"] for k, v in datasets_manifest.get("shards", {}).items()},
        "seed": seed,
        "hardware": hardware_info(),
        "versions": library_versions(),
        "device": device.type,
        "trainingConfig": {**tcfg, "train_windows": len(windows), "epochs": epochs, "learning_rate": lr,
                           "spanish_train_weight": es_w, "steps_per_epoch": steps_per_epoch, "total_steps": total_steps,
                           "freeze": freeze_info,
                           "refinement": cfg["refinement"] if args.mode == "refine" else None},
        "metrics": {"validation": val_m, "train_slice": train_m, "aggregation": agg, "best_aggregation": best_agg,
                    "history": history},
        "overfitting": {"train_loss": train_m["loss"], "val_loss": val_m["loss"], "train_macro_f1": train_m["macro_f1"],
                        "val_macro_f1": val_m["macro_f1"],
                        "gap_macro_f1": (train_m["macro_f1"] or 0) - (val_m["macro_f1"] or 0)},
        "duration": {"train_seconds": round(train_seconds, 1), "post_eval_seconds": round(time.time() - t_eval, 1)},
        "bestCheckpoint": str(best_dir.relative_to(CHECKPOINT_DIR.parent)),
        "lastCheckpoint": str((exp_dir / "last").relative_to(CHECKPOINT_DIR.parent)),
        "checkpointBytes": {"best": dir_size(best_dir), "last": dir_size(exp_dir / "last")},
        "earlyStopped": stop and not (args.max_steps and step >= args.max_steps),
        "stoppedAtStep": step,
    }
    write_json(exp_dir / "experiment.json", experiment)
    log(f"done: val macroF1={val_m['macro_f1']:.4f} train macroF1={train_m['macro_f1']:.4f} "
        f"train {train_seconds / 60:.1f} min -> {exp_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
