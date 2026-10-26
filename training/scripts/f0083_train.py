"""F008.3 training (Colab): R1 = multilingual continual fine-tuning of the F008.2 B_RERANK reranker; D1 = multilingual BGE-M3 bi-encoder.

    python scripts/f0083_train.py reranker
    python scripts/f0083_train.py biencoder

F008.2 artefacts are read-only: R1 starts from a COPY of f008_2/models/final/f008_2_locked_reranker. bf16 / fp16 autodetect,
batch from a memory probe, HF Trainer checkpoints (model + optimizer + scheduler + step + RNG) on Drive, resume_from_checkpoint.
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import write_json  # noqa: E402
from f0082_train import gpu_info, last_ckpt, log, precision, probe_batch  # noqa: E402

DRIVE = Path("/content/drive/MyDrive/turniting")
D = DRIVE / "f008_3"
SPLITS = D / "datasets" / "splits"
CKPT = D / "models" / "checkpoints"
F82_RR = DRIVE / "f008_2" / "models" / "final" / "f008_2_locked_reranker"
R1 = D / "models" / "reranker" / "r1_multilingual"
D1 = D / "models" / "biencoder" / "d1_multilingual_bge_m3"
REPO = Path(__file__).resolve().parents[1]
SEED = 83008
POS = {"FAITHFUL_PARAPHRASE", "STRONG_PARAPHRASE", "LONG_DISTANCE_PARAPHRASE", "STRUCTURAL_REWRITE", "DIRECT_TRANSLATION", "TRANSLATED_PARAPHRASE",
       "PAWS_PARAPHRASE"}
HARD = {"LEXICAL_HARD_NEGATIVE", "NEGATION_HARD_NEGATIVE", "NUMBER_CHANGED_NEGATIVE", "ENTITY_CHANGED_NEGATIVE", "CAUSALITY_CHANGED_NEGATIVE",
        "TEMPORAL_CHANGED_NEGATIVE", "CONTRADICTION", "CROSS_LANGUAGE_HARD_NEGATIVE", "CONTRADICTION_CROSS_LANGUAGE"}


def reranker() -> int:
    import shutil

    import torch
    from datasets import Dataset
    from sentence_transformers.cross_encoder import CrossEncoder, CrossEncoderTrainer, CrossEncoderTrainingArguments
    from sentence_transformers.cross_encoder.losses import BinaryCrossEntropyLoss

    if (R1 / "train_info.json").exists():
        log("R1 already trained")
        return 0
    init = D / "models" / "reranker" / "init_copy_of_f008_2_b_rerank"
    if not init.exists():
        shutil.copytree(F82_RR, init)
    tr = pd.read_parquet(SPLITS / "f008_3_train.parquet")
    tr = tr[tr["label"].notna()]
    tr = pd.concat([tr, tr[tr["pair_class"].isin(HARD) | tr["cross_language"].fillna(False)]], ignore_index=True).sample(frac=1.0, random_state=SEED)
    va = pd.read_parquet(SPLITS / "f008_3_validation.parquet")
    va = va[va["label"].notna() & ~va["doc_level"].fillna(False)].sample(frac=1.0, random_state=SEED).head(6000)
    model = CrossEncoder(str(init), num_labels=1, max_length=384, device="cuda")
    pr = precision()

    def step(b):
        bt = tr.head(b)
        f = model.tokenizer(bt["text_a"].tolist(), bt["text_b"].tolist(), padding=True, truncation=True, max_length=384, return_tensors="pt").to("cuda")
        with torch.autocast("cuda", dtype=torch.bfloat16 if pr["bf16"] else torch.float16):
            model.model(**f).logits.sum().backward()
        model.model.zero_grad(set_to_none=True)

    bs = probe_batch(step, [128, 96, 64, 32, 16])
    ckd = CKPT / "r1"
    args = CrossEncoderTrainingArguments(output_dir=str(ckd), num_train_epochs=1, per_device_train_batch_size=bs, per_device_eval_batch_size=bs,
                                         learning_rate=7e-6, warmup_ratio=0.1, bf16=pr["bf16"], fp16=pr["fp16"], eval_strategy="steps", eval_steps=500,
                                         save_strategy="steps", save_steps=500, save_total_limit=2, load_best_model_at_end=True,
                                         metric_for_best_model="eval_loss", logging_steps=100, seed=SEED, report_to="none", dataloader_num_workers=2)
    trainer = CrossEncoderTrainer(model=model, args=args, loss=BinaryCrossEntropyLoss(model),
                                  train_dataset=Dataset.from_pandas(tr[["text_a", "text_b", "label"]].astype({"label": "float32"}), preserve_index=False),
                                  eval_dataset=Dataset.from_pandas(va[["text_a", "text_b", "label"]].astype({"label": "float32"}), preserve_index=False))
    t0, resume = time.time(), last_ckpt(ckd)
    log(f"R1: {len(tr):,} pairs, batch {bs}, resume {resume}")
    trainer.train(resume_from_checkpoint=resume)
    model.save(str(R1))
    info = {"name": "R1_MULTILINGUAL_RERANKER", "init": "copy of F008.2 B_RERANK (f008_2_locked_reranker)", "pairs": len(tr), "batch_size": bs,
            "gradient_accumulation": 1, "learning_rate": 7e-6, "epochs": 1, "max_sequence_length": 384, "steps": trainer.state.global_step,
            "best_eval_loss": trainer.state.best_metric, "training_duration_s": round(time.time() - t0, 1), **pr, **gpu_info(), "resumed_from": resume}
    write_json(R1 / "train_info.json", info)
    write_json(REPO / "reports" / "f008_3" / "train_r1.json", info)
    return 0


def biencoder() -> int:
    import torch
    from datasets import Dataset, DatasetDict
    from sentence_transformers import SentenceTransformer, SentenceTransformerTrainer, SentenceTransformerTrainingArguments
    from sentence_transformers.losses import CachedMultipleNegativesRankingLoss
    from sentence_transformers.training_args import BatchSamplers

    if (D1 / "train_info.json").exists():
        log("D1 already trained")
        return 0
    tr = pd.read_parquet(SPLITS / "f008_3_train.parquet")
    rng = random.Random(SEED)
    t3, t2 = [], []
    for pid, g in tr.groupby("parent_source_id"):
        pos = g[g["pair_class"].isin(POS)]
        neg = g[g["pair_class"].isin(HARD)]
        for r in pos.itertuples(index=False):
            if len(neg):
                t3.append({"anchor": r.text_a, "positive": r.text_b, "negative": neg.iloc[rng.randrange(len(neg))]["text_b"]})
            else:
                t2.append({"anchor": r.text_a, "positive": r.text_b})
    t3, t2 = pd.DataFrame(t3).sample(frac=1.0, random_state=SEED), pd.DataFrame(t2).sample(frac=1.0, random_state=SEED).head(60000)
    va = pd.read_parquet(SPLITS / "f008_3_validation.parquet")
    va = va[va["pair_class"].isin(POS) & ~va["doc_level"].fillna(False)].head(4000)
    model = SentenceTransformer("BAAI/bge-m3", device="cuda")
    model.max_seq_length = 256
    pr = precision()
    bs = 64
    ckd = CKPT / "d1"
    args = SentenceTransformerTrainingArguments(output_dir=str(ckd), num_train_epochs=1, per_device_train_batch_size=bs, per_device_eval_batch_size=bs,
                                                learning_rate=1e-5, warmup_ratio=0.1, bf16=pr["bf16"], fp16=pr["fp16"],
                                                batch_sampler=BatchSamplers.NO_DUPLICATES, eval_strategy="steps", eval_steps=400, save_strategy="steps",
                                                save_steps=400, save_total_limit=2, load_best_model_at_end=True, metric_for_best_model="eval_loss",
                                                logging_steps=100, seed=SEED, report_to="none", dataloader_num_workers=2)
    trainer = SentenceTransformerTrainer(model=model, args=args, loss=CachedMultipleNegativesRankingLoss(model, mini_batch_size=32),
                                         train_dataset=DatasetDict({"triplets": Dataset.from_pandas(t3, preserve_index=False),
                                                                    "pairs": Dataset.from_pandas(t2, preserve_index=False)}),
                                         eval_dataset=Dataset.from_pandas(va[["text_a", "text_b"]].rename(columns={"text_a": "anchor", "text_b": "positive"}),
                                                                          preserve_index=False))
    t0, resume = time.time(), last_ckpt(ckd)
    log(f"D1: triplets {len(t3):,} pairs {len(t2):,}; resume {resume}")
    trainer.train(resume_from_checkpoint=resume)
    model.save(str(D1))
    info = {"name": "D1_MULTILINGUAL_BGE_M3", "base": "BAAI/bge-m3", "triplets": len(t3), "pairs": len(t2), "batch_size": bs, "learning_rate": 1e-5,
            "epochs": 1, "max_sequence_length": 256, "steps": trainer.state.global_step, "best_eval_loss": trainer.state.best_metric,
            "training_duration_s": round(time.time() - t0, 1), **pr, **gpu_info(), "resumed_from": resume}
    write_json(D1 / "train_info.json", info)
    write_json(REPO / "reports" / "f008_3" / "train_d1.json", info)
    del torch
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["reranker", "biencoder"])
    a = ap.parse_args()
    return reranker() if a.what == "reranker" else biencoder()


if __name__ == "__main__":
    raise SystemExit(main())
