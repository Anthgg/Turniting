"""Train TURNITING_RESEARCH_V3 (GLOBAL, then SPANISH_ACADEMIC refinement) on TURNITING_DATASET_V2.

    python scripts/v3_train.py --mode global --exp 20261017_v3_global \
        --master /content/v3work/master_v2 --eval-sets /content/v3work/eval_sets_v2.parquet \
        --drive /content/drive/MyDrive/turniting/v3
    python scripts/v3_train.py --mode refine --exp <id> --init-from <drive>/checkpoints/<global>/best ...

* training windows are tokenized once (multiprocess) into a cache on /content (copied to Drive);
* DataLoader: length-grouped batches, pin_memory, persistent workers, prefetch;
* auto-batch probe at 512 tokens before training, then gradient accumulation;
* bf16 autocast on A100; best + last checkpoints on Drive; resume from last;
* early stopping only after >= 1 full epoch, patience 3, on VALIDATION V2 (never test).
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import random
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train import adapters_v2 as A  # noqa: E402
from turniting_train.canon import attack_homoglyph, attack_whitespace, attack_zero_width, canonicalize  # noqa: E402
from turniting_train.common import CONFIG_DIR, git_commit, hardware_info, library_versions, load_yaml, set_seed, utc_now, write_json  # noqa: E402
from turniting_train.metrics import binary_metrics  # noqa: E402
from turniting_train.sampling import weighted_sample  # noqa: E402
from turniting_train.transformer import resolve_model  # noqa: E402
from turniting_train.v3model import FINE_TO_B, V3Detector, aggregate, doc_windows, pad_batch, score_texts  # noqa: E402

META = ["id", "dataset", "fine_label", "language", "domain", "is_adversarial", "is_mixed", "n_words"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def read_split(master: Path, split: str, columns, ids=None) -> pd.DataFrame:
    ds = pads.dataset(str(master / split), format="parquet")
    flt = pc.field("id").isin(list(ids)) if ids is not None else None
    return ds.to_table(columns=columns, filter=flt).to_pandas()


def row_weights(meta: pd.DataFrame, sp: dict, es_w: float, aca_w: float) -> np.ndarray:
    dsw = sp["dataset_weights"]
    sig = (meta["fine_label"] != A.HUMAN).astype(int)
    key = meta["dataset"].astype(str) + "|" + sig.astype(str)
    counts = key.map(key.value_counts()).values
    share = np.where(sig == 1, sp["label_balance"], 1 - sp["label_balance"])
    w = meta["dataset"].astype(str).map(lambda d: dsw.get(d, dsw["default"])).astype(float).values * share / counts
    w *= np.where(meta["language"].astype(str) == "es", es_w, 1.0)
    w *= np.where(meta["domain"].astype(str) == "academic", aca_w, 1.0)
    adv = meta["is_adversarial"].values
    frac = w[adv].sum() / w.sum() if adv.any() else 0
    cap = sp["adversarial_cap"]
    if frac > cap:
        w[adv] *= cap * (1 - frac) / (frac * (1 - cap))
    return w


# ------------------------------------------------------------------ tokenization workers

_TOK = None
_TCFG: dict = {}


def _init_tok(path, tcfg):
    global _TOK, _TCFG
    from transformers import AutoTokenizer

    _TOK = AutoTokenizer.from_pretrained(path)
    _TCFG = tcfg


def _tok_docs(docs: list[dict]):
    out = []
    for d in docs:
        rng = random.Random(f"{_TCFG['seed']}:{d['id']}")
        spans = json.loads(d["span_labels"]) if d.get("span_labels") else None
        raw = d["text_original"]
        canon = d["text_normalized"] if d.get("text_normalized") else raw
        if spans is not None:
            text, view = raw, "raw"
        elif rng.random() < _TCFG["canonical_view_prob"]:
            text, view = canon, "canonical"
        else:
            text, view = raw, "raw"
            if rng.random() < _TCFG["attack_prob"]:
                fn = rng.choice([attack_zero_width, attack_homoglyph, attack_whitespace])
                text, view = fn(raw, rng), f"raw+{fn.__name__}"
        ws, offs = doc_windows(_TOK, text, _TCFG["max_length"], _TCFG["stride"], None, offsets=spans is not None)
        if len(ws) > _TCFG["windows_per_doc"]:
            ws = [ws[0]] + rng.sample(ws[1:], _TCFG["windows_per_doc"] - 1)
        fine = d["fine_label"]
        a_doc, b_doc = int(fine != A.HUMAN), FINE_TO_B[fine]
        tok_lab = None
        if spans is not None:
            mask = np.zeros(len(text) + 1, np.int32)
            for s, e, *_ in spans:
                mask[max(0, s):min(len(text), e)] = 1
            cum = np.concatenate([[0], np.cumsum(mask)])
            tok_lab = np.array([1 if cum[min(e, len(text))] - cum[min(s, len(text))] > 0 else 0 for s, e in offs], np.int8)
        for ids, (ts, te) in ws:
            a, b, tl = a_doc, b_doc, None
            if tok_lab is not None:
                part = tok_lab[ts:te]
                frac = float(part.mean()) if len(part) else 0.0
                tl = np.concatenate([[-100], part, [-100]]).astype(np.int8)
                if fine != A.HUMAN:
                    if frac <= 0.05:
                        a, b = 0, 0
                    elif frac >= 0.9:
                        a, b = 1, (2 if b_doc == 2 else 1)
                    else:
                        a, b = 1, 3
            out.append((d["id"], np.asarray(ids, np.int32), a, b, tl, view))
    return out


def build_cache(args, cfg, tcfg, tok_path, mode, es_w, aca_w, cache: Path) -> dict:
    if (cache / "meta.parquet").exists():
        log(f"cache hit {cache}")
        return json.loads((cache / "audit.json").read_text())
    t0 = time.time()
    master = Path(args.master)
    meta = read_split(master, "train", META)
    meta = meta[meta["fine_label"].isin(list(FINE_TO_B))].reset_index(drop=True)
    sp = cfg["sampling"]
    w = row_weights(meta, sp, es_w, aca_w)
    n_windows = cfg["refinement"]["train_windows"] if mode == "refine" else tcfg["train_windows"]
    n_docs = int(n_windows / 1.55)
    seed = cfg["seed"] + (7 if mode == "refine" else 0)
    if mode == "refine":
        target = ((meta["language"] == "es") | (meta["domain"] == "academic") |
                  meta["fine_label"].isin([A.MIXED, A.AI_EDITED, A.HUMAN_EDITED_AI])).values
        n_t = int(n_docs * cfg["refinement"]["target_fraction"])
        docs = pd.concat([weighted_sample(meta[target], w[target], n_t, seed),
                          weighted_sample(meta[~target], w[~target], n_docs - n_t, seed + 1)])
    else:
        docs = weighted_sample(meta, w, n_docs, seed)
    docs = docs.sample(frac=1.0, random_state=seed)
    log(f"sampled {len(docs):,} docs from {len(meta):,} train rows ({time.time() - t0:.0f}s); loading text")
    texts = read_split(master, "train", ["id", "text_original", "text_normalized", "fine_label", "span_labels"],
                       ids=docs["id"].tolist()).set_index("id").loc[docs["id"]].reset_index()
    recs = texts.to_dict("records")
    del texts
    jobs = [recs[i:i + 500] for i in range(0, len(recs), 500)]
    ids_all, seqs, la, lb, tls, views = [], [], [], [], [], []
    with mp.get_context("fork" if "fork" in mp.get_all_start_methods() else "spawn").Pool(args.workers, initializer=_init_tok, initargs=(tok_path, tcfg)) as pool:
        for k, res in enumerate(pool.imap(_tok_docs, jobs)):
            for doc_id, ids, a, b, tl, view in res:
                ids_all.append(doc_id); seqs.append(ids); la.append(a); lb.append(b); tls.append(tl); views.append(view)
            if len(seqs) >= n_windows:
                break
            if k % 200 == 0:
                log(f"  tokenized {len(seqs):,} windows")
    seqs, la, lb, tls, views, ids_all = (x[:n_windows] for x in (seqs, la, lb, tls, views, ids_all))
    cache.mkdir(parents=True, exist_ok=True)
    lens = np.array([len(s) for s in seqs], np.int32)
    np.save(cache / "tokens.npy", np.concatenate(seqs).astype(np.int32))
    np.save(cache / "lens.npy", lens)
    tl_len = np.array([0 if t is None else len(t) for t in tls], np.int32)
    np.save(cache / "toklab.npy", np.concatenate([t for t in tls if t is not None] or [np.zeros(0, np.int8)]).astype(np.int8))
    np.save(cache / "toklab_lens.npy", tl_len)
    wm = pd.DataFrame({"doc_id": ids_all, "a": la, "b": lb, "view": views, "len": lens})
    wm = wm.merge(docs[META].rename(columns={"id": "doc_id"}), on="doc_id", how="left")
    wm.to_parquet(cache / "meta.parquet", index=False)
    by_ds = wm.groupby("dataset").agg(windows=("a", "size"), docs=("doc_id", "nunique"), machine_signal=("a", "mean"))
    audit = {
        "mode": mode, "training_windows": int(len(wm)), "training_docs": int(wm["doc_id"].nunique()),
        "machine_signal_share": float(wm["a"].mean()), "fine_head_distribution": wm["b"].value_counts().sort_index().tolist(),
        "spanish_windows": int((wm["language"] == "es").sum()), "academic_windows": int((wm["domain"] == "academic").sum()),
        "span_labeled_windows": int((tl_len > 0).sum()), "adversarial_windows": int(wm["is_adversarial"].sum()),
        "views": wm["view"].value_counts().to_dict(), "mean_tokens": float(lens.mean()),
        "spanish_weight": es_w, "academic_weight": aca_w,
        "by_dataset": {str(k): {"windows": int(v.windows), "docs": int(v.docs), "machine_signal": round(float(v.machine_signal), 3)}
                       for k, v in by_ds.iterrows()},
        "seconds": round(time.time() - t0, 1),
    }
    write_json(cache / "audit.json", audit)
    log(f"cache built: {len(wm):,} windows in {audit['seconds']}s")
    return audit


class WindowData(torch.utils.data.Dataset):
    def __init__(self, cache: Path):
        self.tokens = np.load(cache / "tokens.npy", mmap_mode="r")
        self.lens = np.load(cache / "lens.npy")
        self.off = np.concatenate([[0], np.cumsum(self.lens)]).astype(np.int64)
        self.tl = np.load(cache / "toklab.npy", mmap_mode="r")
        tll = np.load(cache / "toklab_lens.npy")
        self.tl_off = np.concatenate([[0], np.cumsum(tll)]).astype(np.int64)
        self.tl_has = tll > 0
        m = pd.read_parquet(cache / "meta.parquet", columns=["a", "b"])
        self.a = m["a"].values.astype(np.float32)
        self.b = m["b"].values.astype(np.int64)

    def __len__(self):
        return len(self.lens)

    def __getitem__(self, i):
        ids = np.asarray(self.tokens[self.off[i]: self.off[i + 1]])
        tl = np.asarray(self.tl[self.tl_off[i]: self.tl_off[i + 1]]) if self.tl_has[i] else None
        return ids, self.a[i], self.b[i], tl


class Collate:
    def __init__(self, pad_id):
        self.pad_id = pad_id

    def __call__(self, items):
        ids, mask, tl = pad_batch([x[0] for x in items], self.pad_id, [x[3] for x in items])
        return {"input_ids": ids, "attention_mask": mask, "a": torch.tensor([x[1] for x in items]),
                "b": torch.tensor([x[2] for x in items]), "c": tl}


def epoch_batches(lens: np.ndarray, micro: int, seed: int, epoch: int) -> list[list[int]]:
    """Length-grouped shuffled batches: little padding, still random order."""
    rng = np.random.default_rng(seed + epoch)
    perm = rng.permutation(len(lens))
    mega = micro * 64
    batches = []
    for s in range(0, len(perm), mega):
        chunk = perm[s:s + mega]
        chunk = chunk[np.argsort(lens[chunk], kind="stable")]
        batches.extend(chunk[i:i + micro].tolist() for i in range(0, len(chunk), micro))
    order = rng.permutation(len(batches))
    return [batches[i] for i in order]


def auto_batch(model, device, max_length, target_frac, candidates=(8, 16, 24, 32, 40, 48, 64, 80, 96, 128)) -> dict:
    total = torch.cuda.get_device_properties(0).total_memory
    model.train()
    results, best = {}, candidates[0]
    for bs in candidates:
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        try:
            ids = torch.randint(5, 1000, (bs, max_length), device=device)
            mask = torch.ones_like(ids)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                out = model(ids, mask)
                loss = out["a"].float().mean() + out["b"].float().mean() + out["c"].float().mean()
            loss.backward()
            model.zero_grad(set_to_none=True)
            peak = torch.cuda.max_memory_allocated()
            results[bs] = round(peak / 1e9, 2)
            log(f"  auto-batch {bs}: peak {peak / 1e9:.1f} GB ({peak / total:.0%})")
            if peak / total > target_frac:
                break
            best = bs
        except torch.cuda.OutOfMemoryError:
            results[bs] = "OOM"
            log(f"  auto-batch {bs}: OOM")
            model.zero_grad(set_to_none=True)
            break
    torch.cuda.empty_cache()
    return {"micro_batch": best, "probe_peak_gb": results, "vram_total_gb": round(total / 1e9, 1), "target_frac": target_frac}


class GpuMonitor(threading.Thread):
    def __init__(self, every=20):
        super().__init__(daemon=True)
        self.every, self.samples, self.stop_flag = every, [], False

    def run(self):
        while not self.stop_flag:
            try:
                out = subprocess.check_output(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total",
                                               "--format=csv,noheader,nounits"], text=True).strip().split(",")
                self.samples.append((float(out[0]), float(out[1]) / 1024, float(out[2]) / 1024))
            except Exception:
                pass
            time.sleep(self.every)

    def summary(self):
        if not self.samples:
            return {}
        u = np.array([s[0] for s in self.samples])
        m = np.array([s[1] for s in self.samples])
        return {"gpu_util_mean": round(float(u.mean()), 1), "gpu_util_p50": round(float(np.median(u)), 1),
                "gpu_util_p90": round(float(np.percentile(u, 90)), 1), "vram_used_max_gb": round(float(m.max()), 1),
                "vram_total_gb": round(self.samples[0][2], 1), "samples": len(u)}


def eval_frame(args, ev: pd.DataFrame, names: list[str], cap: int | None, seed: int) -> pd.DataFrame:
    ids = ev[ev["eval_set"].isin(names)]
    if cap:
        ids = ids.drop_duplicates("id").sample(min(cap, ids["id"].nunique()), random_state=seed)
    frames = []
    for split, g in ids.groupby("split"):
        frames.append(read_split(Path(args.master), split, ["id", "text_original", "fine_label", "language", "domain",
                                                            "dataset"], ids=g["id"].unique().tolist()))
    return pd.concat(frames, ignore_index=True).drop_duplicates("id")


def evaluate(model, tok, frame: pd.DataFrame, tcfg, device, method="mean") -> dict:
    texts = [canonicalize(t) for t in frame["text_original"]]
    scores = score_texts(model, tok, texts, tcfg["max_length"], tcfg["stride"], 8, batch_size=256, device=device)
    logit = np.array([aggregate(s["a"], method) for s in scores])
    p = 1 / (1 + np.exp(-logit))
    y = (frame["fine_label"] != A.HUMAN).astype(int).values
    es = (frame["language"] == "es").values
    aca = (frame["domain"] == "academic").values
    m_all = binary_metrics(y, p, 0.5)
    m_es = binary_metrics(y[es], p[es], 0.5) if es.sum() > 20 else {"macro_f1": None}
    m_aca = binary_metrics(y[aca], p[aca], 0.5) if aca.sum() > 20 else {"macro_f1": None}
    parts = [v for v in (m_all["macro_f1"], m_es["macro_f1"], m_aca["macro_f1"]) if v is not None]
    pcl = np.clip(p, 1e-7, 1 - 1e-7)
    return {"primary": float(np.mean(parts)), "macro_f1": m_all["macro_f1"], "spanish_macro_f1": m_es["macro_f1"],
            "academic_macro_f1": m_aca["macro_f1"], "roc_auc": m_all.get("roc_auc"), "fpr": m_all.get("fpr"),
            "loss": float(-np.mean(y * np.log(pcl) + (1 - y) * np.log(1 - pcl))), "n": int(len(y))}


class DriveSync:
    """Copy a finished local checkpoint dir to Drive in the background (one copy at a time)."""

    def __init__(self):
        self.t = None

    def push(self, src: Path, dst: Path):
        self.wait()

        def run():
            tmp = dst.with_name(dst.name + ".tmp")
            if tmp.exists():
                shutil.rmtree(tmp)
            shutil.copytree(src, tmp)
            if dst.exists():
                shutil.rmtree(dst)
            os.replace(tmp, dst)
        self.t = threading.Thread(target=run, daemon=True)
        self.t.start()

    def wait(self):
        if self.t is not None:
            self.t.join()
            self.t = None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(CONFIG_DIR / "v3.yaml"))
    ap.add_argument("--mode", choices=["global", "refine"], default="global")
    ap.add_argument("--exp", required=True)
    ap.add_argument("--master", default="/content/v3work/master_v2")
    ap.add_argument("--eval-sets", default="/content/v3work/eval_sets_v2.parquet")
    ap.add_argument("--drive", default="/content/drive/MyDrive/turniting/v3")
    ap.add_argument("--local", default="/content/ckpt")
    ap.add_argument("--cache-root", default="/content/cache")
    ap.add_argument("--init-from")
    ap.add_argument("--weights", help="json with selected spanish/academic weights")
    ap.add_argument("--workers", type=int, default=max(1, min((os.cpu_count() or 2) - 1, 12)))
    ap.add_argument("--dry-run", action="store_true", help="build cache + audit + auto-batch, no training")
    ap.add_argument("--max-steps", type=int)
    ap.add_argument("--post-eval-cap", type=int, help="smoke tests only: cap the final validation docs")
    ap.add_argument("--skip-train", action="store_true", help="smoke tests only: reuse the existing best checkpoint")
    args = ap.parse_args()
    cfg = load_yaml(Path(args.config))["train"]
    tcfg = {k: cfg[k] for k in ("max_length", "stride", "windows_per_doc", "train_windows", "canonical_view_prob",
                                "attack_prob", "seed")}
    set_seed(cfg["seed"])
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    drive_exp = Path(args.drive) / "checkpoints" / args.exp
    local_exp = Path(args.local) / args.exp
    drive_exp.mkdir(parents=True, exist_ok=True)
    local_exp.mkdir(parents=True, exist_ok=True)
    sel = json.loads(Path(args.weights).read_text()) if args.weights and Path(args.weights).exists() else {}
    es_w = sel.get("spanish_weight", cfg["sampling"]["spanish_weight"])
    aca_w = sel.get("academic_weight", cfg["sampling"]["academic_weight"])
    log(f"exp {args.exp} mode={args.mode} device={device} es_w={es_w} aca_w={aca_w} workers={args.workers}")

    from transformers import AutoTokenizer, get_linear_schedule_with_warmup

    base_path = resolve_model(cfg["model"], cfg["revision"])
    init = args.init_from or base_path
    tok_path = str(Path(init) / "backbone") if (Path(init) / "backbone").exists() else init
    tok = AutoTokenizer.from_pretrained(tok_path)

    cache = Path(args.cache_root) / args.exp
    drive_cache = drive_exp / "cache"
    if not (cache / "meta.parquet").exists() and (drive_cache / "meta.parquet").exists():
        shutil.copytree(drive_cache, cache, dirs_exist_ok=True)
    audit = build_cache(args, cfg, tcfg, tok_path, args.mode, es_w, aca_w, cache)
    write_json(drive_exp / "sample_audit.json", audit)
    if not (drive_cache / "meta.parquet").exists():
        shutil.copytree(cache, drive_cache, dirs_exist_ok=True)
    log("sample audit: " + json.dumps({k: v for k, v in audit.items() if k != "by_dataset"}))

    if (Path(init) / "heads.pt").exists():
        model = V3Detector.load(init)
    else:
        model = V3Detector.from_base(init)
    model.to(device)
    probe = auto_batch(model, device, cfg["max_length"], 0.84) if device.type == "cuda" else {"micro_batch": 4}
    micro = probe["micro_batch"]
    accum = max(1, round(cfg["effective_batch"] / micro))
    log(f"micro batch {micro} x accum {accum} = effective {micro * accum}")
    write_json(drive_exp / "auto_batch.json", {**probe, "accumulation": accum, "effective_batch": micro * accum})
    if args.dry_run:
        log("dry run: no training")
        return 0

    ev = pd.read_parquet(args.eval_sets)
    val = eval_frame(args, ev, ["validation_v2", "validation_v2_spanish", "validation_v2_academic"],
                     cfg["eval_docs_during_training"], cfg["seed"])
    log(f"validation slice during training: {len(val):,} docs")

    data = WindowData(cache)
    rc = cfg["refinement"]
    epochs = rc["epochs"] if args.mode == "refine" else cfg["epochs"]
    lr = rc["learning_rate"] if args.mode == "refine" else cfg["learning_rate"]
    eval_every = rc["eval_every_steps"] if args.mode == "refine" else cfg["eval_every_steps"]
    steps_per_epoch = math.ceil(len(data) / (micro * accum))
    total_steps = steps_per_epoch * epochs
    decay, no_decay = [], []
    for n_, p_ in model.named_parameters():
        (no_decay if p_.ndim < 2 or "LayerNorm" in n_ or "bias" in n_ else decay).append(p_)
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": cfg["weight_decay"]}, {"params": no_decay, "weight_decay": 0.0}],
                            lr=lr, fused=device.type == "cuda")
    sched = get_linear_schedule_with_warmup(opt, int(total_steps * cfg["warmup_ratio"]), total_steps)
    step, best, bad, history = 0, -1.0, 0, []
    last_local, best_local = local_exp / "last", local_exp / "best"
    if (drive_exp / "last" / "trainer_state.pt").exists():
        shutil.copytree(drive_exp / "last", last_local, dirs_exist_ok=True)
        model = V3Detector.load(last_local).to(device)
        opt = torch.optim.AdamW([{"params": [p for n_, p in model.named_parameters() if not (p.ndim < 2 or "LayerNorm" in n_ or "bias" in n_)],
                                  "weight_decay": cfg["weight_decay"]},
                                 {"params": [p for n_, p in model.named_parameters() if (p.ndim < 2 or "LayerNorm" in n_ or "bias" in n_)],
                                  "weight_decay": 0.0}], lr=lr, fused=device.type == "cuda")
        sched = get_linear_schedule_with_warmup(opt, int(total_steps * cfg["warmup_ratio"]), total_steps)
        st = torch.load(last_local / "trainer_state.pt", weights_only=False)
        opt.load_state_dict(st["optimizer"])
        sched.load_state_dict(st["scheduler"])
        step, best, bad, history = st["step"], st["best"], st["bad"], st["history"]
        log(f"resumed from Drive last at step {step} (best {best:.4f})")

    hw = cfg["heads"]
    bce = torch.nn.BCEWithLogitsLoss()
    ce = torch.nn.CrossEntropyLoss()
    sync = DriveSync()
    mon = GpuMonitor()
    mon.start()
    t0 = time.time()
    seen = 0
    stop = False
    collate = Collate(tok.pad_token_id)
    model.train()
    for epoch in range(0 if args.skip_train else epochs):
        batches = epoch_batches(data.lens, micro, cfg["seed"], epoch)
        groups = [batches[i:i + accum] for i in range(0, len(batches), accum)]
        start_group = max(0, step - epoch * steps_per_epoch)
        if start_group >= len(groups):
            continue
        flat = [b for g in groups[start_group:] for b in g]
        loader = torch.utils.data.DataLoader(data, batch_sampler=flat, collate_fn=collate, num_workers=args.workers,
                                             pin_memory=True, persistent_workers=True, prefetch_factor=cfg["prefetch_factor"])
        it = iter(loader)
        for g in groups[start_group:]:
            tot = {"a": 0.0, "b": 0.0, "c": 0.0}
            for _ in g:
                batch = next(it)
                ids = batch["input_ids"].to(device, non_blocking=True)
                mask = batch["attention_mask"].to(device, non_blocking=True)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    out = model(ids, mask)
                la = bce(out["a"].float(), batch["a"].to(device))
                lb = ce(out["b"].float(), batch["b"].to(device))
                tl = batch["c"].to(device)
                valid = tl != -100
                lc = bce(out["c"].float()[valid], tl[valid].float()) if valid.any() else torch.zeros((), device=device)
                loss = (hw["binary_weight"] * la + hw["fine_weight"] * lb + hw["token_weight"] * lc) / len(g)
                if not torch.isfinite(loss):
                    raise RuntimeError(f"ABORT: non-finite loss at step {step}")
                loss.backward()
                tot["a"] += float(la) / len(g); tot["b"] += float(lb) / len(g); tot["c"] += float(lc) / len(g)
                seen += ids.shape[0]
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            if step % 50 == 0:
                el = time.time() - t0
                log(f"  step {step}/{total_steps} ep {step / steps_per_epoch:.2f} loss a={tot['a']:.4f} b={tot['b']:.4f} "
                    f"c={tot['c']:.4f} lr={sched.get_last_lr()[0]:.2e} {seen / el:.0f} win/s "
                    f"mem={torch.cuda.max_memory_allocated() / 1e9 if device.type == 'cuda' else 0:.1f}GB")
            if step % eval_every == 0 or step == total_steps or (args.max_steps and step >= args.max_steps):
                m = evaluate(model, tok, val, cfg, device)
                model.train()
                rec = {"step": step, "epoch": round(step / steps_per_epoch, 3), **m, "lr": sched.get_last_lr()[0],
                       "elapsed_s": round(time.time() - t0, 1), "gpu": mon.summary()}
                history.append(rec)
                log(f"  EVAL step {step}: primary={m['primary']:.4f} macroF1={m['macro_f1']:.4f} es={m['spanish_macro_f1']} "
                    f"aca={m['academic_macro_f1']} auc={m['roc_auc']}")
                if m["primary"] > best:
                    best, bad = m["primary"], 0
                    model.save(best_local, tok, {"step": step, "primary": best, "exp": args.exp, "mode": args.mode})
                    sync.push(best_local, drive_exp / "best")
                    sync.wait()
                elif step / steps_per_epoch >= cfg["min_epochs_before_early_stop"]:
                    bad += 1
                model.save(last_local, tok, {"step": step})
                torch.save({"optimizer": opt.state_dict(), "scheduler": sched.state_dict(), "step": step, "best": best,
                            "bad": bad, "history": history}, last_local / "trainer_state.pt")
                sync.push(last_local, drive_exp / "last")
                with open(drive_exp / "train_log.jsonl", "a") as fh:
                    fh.write(json.dumps(rec) + "\n")
                if bad >= cfg["early_stopping_patience"]:
                    log("early stopping (validation primary did not improve for 3 evaluations after epoch 1)")
                    stop = True
                if args.max_steps and step >= args.max_steps:
                    stop = True
            if stop:
                break
        del loader, it
        if stop:
            break
    sync.wait()
    mon.stop_flag = True
    train_s = time.time() - t0

    # ---------------- post-training on the full VALIDATION V2 (20k): aggregation + view selection
    model = V3Detector.load(drive_exp / "best", device)
    full = eval_frame(args, ev, ["validation_v2"], args.post_eval_cap, cfg["seed"])
    t1 = time.time()
    res = {}
    views = {"canonical": [canonicalize(t) for t in full["text_original"]], "raw": full["text_original"].tolist()}
    sc = {v: score_texts(model, tok, tx, cfg["max_length"], cfg["stride"], 8, batch_size=256, device=device)
          for v, tx in views.items()}
    y = (full["fine_label"] != A.HUMAN).astype(int).values
    for v in ("canonical", "raw", "avg"):
        for method in ("mean", "trimmed_mean", "topk_mean", "max"):
            if v == "avg":
                lg = np.array([(aggregate(a["a"], method) + aggregate(b["a"], method)) / 2 for a, b in zip(sc["canonical"], sc["raw"])])
            else:
                lg = np.array([aggregate(s["a"], method) for s in sc[v]])
            res[f"{v}|{method}"] = binary_metrics(y, 1 / (1 + np.exp(-lg)), 0.5)["macro_f1"]
    choice = max(res, key=res.get)
    view, method = choice.split("|")
    log(f"view/aggregation on validation V2: {choice} -> {res[choice]:.4f}")
    if view == "avg":
        lg = np.array([(aggregate(a["a"], method) + aggregate(b["a"], method)) / 2 for a, b in zip(sc["canonical"], sc["raw"])])
    else:
        lg = np.array([aggregate(s["a"], method) for s in sc[view]])
    bprob = np.array([s["b"].mean(0) for s in sc["canonical"]])
    out = full[["id", "fine_label", "language", "domain", "dataset"]].copy()
    out["label"] = y
    out["logit"] = lg
    for k, name in enumerate(["p_human", "p_generated", "p_edited", "p_mixed"]):
        out[name] = bprob[:, k]
    out.to_parquet(drive_exp / "validation_doc_logits.parquet", index=False)
    icfg = {"max_length": cfg["max_length"], "stride": cfg["stride"], "max_windows_per_doc": 8, "view": view,
            "aggregation": method, "selection_on_validation_v2": res}
    (drive_exp / "best" / "inference_config.json").write_text(json.dumps(icfg, indent=2))
    write_json(drive_exp / "experiment.json", {
        "experimentId": args.exp, "mode": args.mode, "timestamp": utc_now(), "gitCommit": git_commit(),
        "model": cfg["model"], "modelRevision": cfg["revision"], "initFrom": args.init_from, "datasetVersion": "TURNITING_DATASET_V2",
        "hardware": hardware_info(), "versions": library_versions(), "autoBatch": probe, "microBatch": micro,
        "accumulation": accum, "epochs": epochs, "learningRate": lr, "stepsPerEpoch": steps_per_epoch, "totalSteps": total_steps,
        "stoppedAtStep": step, "earlyStopped": bool(stop and not (args.max_steps and step >= args.max_steps)),
        "bestPrimary": best, "history": history, "trainSeconds": round(train_s, 1), "postEvalSeconds": round(time.time() - t1, 1),
        "throughputWindowsPerSec": round(seen / max(train_s, 1), 1), "gpuMonitor": mon.summary(),
        "peakVramGb": round(torch.cuda.max_memory_allocated() / 1e9, 2) if device.type == "cuda" else None,
        "sampleAudit": audit, "inferenceConfig": icfg, "spanishWeight": es_w, "academicWeight": aca_w,
    })
    log(f"done {args.exp}: best primary {best:.4f}, {train_s / 3600:.2f} h, {seen / max(train_s, 1):.0f} win/s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
