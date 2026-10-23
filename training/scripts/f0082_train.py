"""F008.2 training on Colab: (A) contrastive bi-encoder, (B) paraphrase cross-encoder / reranker. Resumable from Drive checkpoints.

    python scripts/f0082_train.py biencoder
    python scripts/f0082_train.py reranker

* A: BAAI/bge-m3 (dense) fine-tuned with MultipleNegativesRankingLoss on (anchor, positive, hard negative) triplets: Claude seeds
  with their paraphrases / translations against the lexical / negation / number / entity / causality negatives of the SAME seed,
  plus PAWS-X es TRAIN paraphrase pairs (with a same-source negative when one exists). PARTIAL paraphrases are not used here.
* B: BAAI/bge-reranker-v2-m3 fine-tuned with BCE on every TRAIN pair (PARTIAL = soft label 0.5).
* Frozen references are never overwritten: new weights go to MyDrive/turniting/f008_2/models/{biencoder,reranker}.
* Precision bf16 when supported, else fp16; batch size from a memory probe; checkpoints (model + optimizer + scheduler + step +
  RNG via the HF Trainer) every N steps on Drive; an existing checkpoint is always resumed, never restarted.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import BASE_BIENCODER, BASE_RERANKER, BIENC, CKPT, LOGS, NEGATIVE, POSITIVE, REPO, SEED, SPLITS, write_json  # noqa: E402

HARD = [c for c in NEGATIVE if c != "SAME_TOPIC_NEGATIVE"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def precision():
    import torch

    bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    return {"bf16": bf16, "fp16": torch.cuda.is_available() and not bf16}


def gpu_info() -> dict:
    import torch

    if not torch.cuda.is_available():
        return {}
    p = torch.cuda.get_device_properties(0)
    return {"gpu": p.name, "vram_gib": round(p.total_memory / 2**30, 1), "cuda": torch.version.cuda}


def last_ckpt(d: Path):
    from transformers.trainer_utils import get_last_checkpoint

    return get_last_checkpoint(str(d)) if d.exists() else None


def probe_batch(step_fn, candidates) -> int:
    """largest candidate batch whose forward+backward fits with ~15 % VRAM headroom (tiny probe before the full run)"""
    import torch

    best = candidates[-1]
    for b in candidates:
        try:
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            step_fn(b)
            peak = torch.cuda.max_memory_allocated() / torch.cuda.get_device_properties(0).total_memory
            log(f"probe batch {b}: peak {peak:.2f} of VRAM")
            if peak < 0.85:
                return b
        except torch.cuda.OutOfMemoryError:
            log(f"probe batch {b}: OOM")
        except Exception as e:  # noqa: BLE001  probe itself failed: fall back to a conservative size
            log(f"probe failed ({type(e).__name__}: {str(e)[:120]}); using {candidates[-2]}")
            return candidates[-2]
        best = b
    return best


def triplets(tr: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    rng = random.Random(SEED)
    rows3, rows2 = [], []
    cl = tr[tr["dataset"] == "claude_pairs"]
    for sid, g in cl.groupby("parent_source_id"):
        pos = g[g["pair_class"].isin(["FAITHFUL_PARAPHRASE", "STRONG_PARAPHRASE", "STRUCTURAL_REWRITE", "TRANSLATED_PARAPHRASE"])]
        neg = g[g["pair_class"].isin(HARD)]
        for r in pos.itertuples(index=False):
            if len(neg):
                rows3.append({"anchor": r.text_a, "positive": r.text_b, "negative": neg.iloc[rng.randrange(len(neg))]["text_b"]})
            else:
                rows2.append({"anchor": r.text_a, "positive": r.text_b})
    pw = tr[tr["dataset"] == "pawsx_es_train"]
    negs = pw[pw["label"] == 0].groupby("text_a")["text_b"].first()
    for r in pw[pw["label"] == 1].itertuples(index=False):
        n = negs.get(r.text_a)
        (rows3 if isinstance(n, str) else rows2).append({"anchor": r.text_a, "positive": r.text_b, **({"negative": n} if isinstance(n, str) else {})})
    return pd.DataFrame(rows3).sample(frac=1.0, random_state=SEED), pd.DataFrame(rows2).sample(frac=1.0, random_state=SEED)


def biencoder() -> int:
    import torch
    from datasets import Dataset, DatasetDict
    from sentence_transformers import SentenceTransformer, SentenceTransformerTrainer, SentenceTransformerTrainingArguments
    from sentence_transformers.losses import CachedMultipleNegativesRankingLoss
    from sentence_transformers.training_args import BatchSamplers

    out = BIENC / "ft_bge_m3"
    if (out / "train_info.json").exists():
        log("bi-encoder already trained")
        return 0
    tr = pd.read_parquet(SPLITS / "f008_2_train.parquet")
    val = pd.read_parquet(SPLITS / "f008_2_validation.parquet")
    t3, t2 = triplets(tr)
    vpos = val[(val["label"] == 1) & (val["lang_b"].isin(["es", "en"]))]
    model = SentenceTransformer(BASE_BIENCODER, device="cuda")
    model.max_seq_length = 256
    pr = precision()

    def step(b):
        loss = CachedMultipleNegativesRankingLoss(model, mini_batch_size=min(b, 64))
        batch = t3.head(b)
        f = [model.tokenize(batch[c].tolist()) for c in ("anchor", "positive", "negative")]
        f = [{k: v.cuda() for k, v in x.items()} for x in f]
        with torch.autocast("cuda", dtype=torch.bfloat16 if pr["bf16"] else torch.float16):
            loss(f, None).backward()
        model.zero_grad(set_to_none=True)

    bs = probe_batch(step, [256, 192, 128, 64, 32])
    ckd = CKPT / "biencoder"
    args = SentenceTransformerTrainingArguments(
        output_dir=str(ckd), num_train_epochs=1, per_device_train_batch_size=bs, per_device_eval_batch_size=bs, learning_rate=1e-5, warmup_ratio=0.1,
        bf16=pr["bf16"], fp16=pr["fp16"], batch_sampler=BatchSamplers.NO_DUPLICATES, eval_strategy="steps", eval_steps=300, save_strategy="steps",
        save_steps=300, save_total_limit=2, load_best_model_at_end=True, metric_for_best_model="eval_loss", logging_steps=50, seed=SEED, report_to="none",
        gradient_checkpointing=False, dataloader_num_workers=2)
    loss = CachedMultipleNegativesRankingLoss(model, mini_batch_size=min(bs, 64))
    trainer = SentenceTransformerTrainer(model=model, args=args, loss=loss,
                                         train_dataset=DatasetDict({"triplets": Dataset.from_pandas(t3, preserve_index=False),
                                                                    "pairs": Dataset.from_pandas(t2, preserve_index=False)}),
                                         eval_dataset=Dataset.from_pandas(vpos[["text_a", "text_b"]].rename(columns={"text_a": "anchor", "text_b": "positive"}),
                                                                          preserve_index=False))
    t0 = time.time()
    resume = last_ckpt(ckd)
    log(f"bi-encoder: triplets {len(t3):,} pairs {len(t2):,}; batch {bs}; resume {resume}")
    trainer.train(resume_from_checkpoint=resume)
    model.save(str(out))
    info = {"base_model": BASE_BIENCODER, "loss": "CachedMultipleNegativesRankingLoss (in-batch + same-seed hard negatives)", "triplets": len(t3),
            "pairs": len(t2), "batch_size": bs, "gradient_accumulation": 1, "effective_batch_size": bs, "max_sequence_length": 256, "learning_rate": 1e-5,
            "epochs": 1, "steps": trainer.state.global_step, "best_checkpoint": trainer.state.best_model_checkpoint, "best_eval_loss": trainer.state.best_metric,
            "training_duration_s": round(time.time() - t0, 1), **pr, **gpu_info(), "resumed_from": resume}
    write_json(out / "train_info.json", info)
    write_json(REPO / "reports" / "f008_2" / "train_biencoder.json", info)
    return 0


def reranker() -> int:
    import torch
    from datasets import Dataset
    from sentence_transformers.cross_encoder import CrossEncoder, CrossEncoderTrainer, CrossEncoderTrainingArguments
    from sentence_transformers.cross_encoder.losses import BinaryCrossEntropyLoss

    out = BIENC.parent / "reranker" / "ft_bge_reranker_v2_m3"
    if (out / "train_info.json").exists():
        log("reranker already trained")
        return 0
    tr = pd.read_parquet(SPLITS / "f008_2_train.parquet")
    tr = tr[tr["label"].notna()]
    cl = tr[tr["dataset"] == "claude_pairs"]
    tr = pd.concat([tr, cl[cl["pair_class"].isin(HARD)]], ignore_index=True)  # hard negatives seen twice
    tr = tr.sample(frac=1.0, random_state=SEED)
    val = pd.read_parquet(SPLITS / "f008_2_validation.parquet")
    val = val[val["label"].notna()]
    model = CrossEncoder(BASE_RERANKER, num_labels=1, max_length=384, device="cuda")
    pr = precision()

    def step(b):
        batch = tr.head(b)
        f = model.tokenizer(batch["text_a"].tolist(), batch["text_b"].tolist(), padding=True, truncation=True, max_length=384, return_tensors="pt").to("cuda")
        with torch.autocast("cuda", dtype=torch.bfloat16 if pr["bf16"] else torch.float16):
            model.model(**f).logits.sum().backward()
        model.model.zero_grad(set_to_none=True)

    bs = probe_batch(step, [128, 96, 64, 32, 16])
    ckd = CKPT / "reranker"
    args = CrossEncoderTrainingArguments(
        output_dir=str(ckd), num_train_epochs=1, per_device_train_batch_size=bs, per_device_eval_batch_size=bs, learning_rate=1e-5, warmup_ratio=0.1,
        bf16=pr["bf16"], fp16=pr["fp16"], eval_strategy="steps", eval_steps=400, save_strategy="steps", save_steps=400, save_total_limit=2,
        load_best_model_at_end=True, metric_for_best_model="eval_loss", logging_steps=50, seed=SEED, report_to="none", dataloader_num_workers=2)
    trainer = CrossEncoderTrainer(model=model, args=args, loss=BinaryCrossEntropyLoss(model),
                                  train_dataset=Dataset.from_pandas(tr[["text_a", "text_b", "label"]].astype({"label": "float32"}), preserve_index=False),
                                  eval_dataset=Dataset.from_pandas(val[["text_a", "text_b", "label"]].astype({"label": "float32"}), preserve_index=False))
    t0 = time.time()
    resume = last_ckpt(ckd)
    log(f"reranker: {len(tr):,} pairs; batch {bs}; resume {resume}")
    trainer.train(resume_from_checkpoint=resume)
    model.save(str(out))
    info = {"base_model": BASE_RERANKER, "loss": "BinaryCrossEntropy (PARTIAL = 0.5)", "pairs": len(tr), "batch_size": bs, "gradient_accumulation": 1,
            "effective_batch_size": bs, "max_sequence_length": 384, "learning_rate": 1e-5, "epochs": 1, "steps": trainer.state.global_step,
            "best_checkpoint": trainer.state.best_model_checkpoint, "best_eval_loss": trainer.state.best_metric, "training_duration_s": round(time.time() - t0, 1),
            **pr, **gpu_info(), "resumed_from": resume}
    write_json(out / "train_info.json", info)
    write_json(REPO / "reports" / "f008_2" / "train_reranker.json", info)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["biencoder", "reranker"])
    a = ap.parse_args()
    LOGS.mkdir(parents=True, exist_ok=True)
    return biencoder() if a.what == "biencoder" else reranker()


if __name__ == "__main__":
    raise SystemExit(main())
