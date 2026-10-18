"""F006 targeted fine-tuning from the TURNITING_RESEARCH_V3 best checkpoint (low-FPR, generalization hardening).

    python scripts/f006_train.py --run A1_h50_r30_ce --windows 150000 --human-share 0.5 --hard-ratio 0.3 --loss ce
    python scripts/f006_train.py --run F006_FULL --stage full --windows 450000 ... (selected config)

Differences from v3_train.py (whose data/batching/monitoring code is reused):
* sampling: HUMAN/MACHINE effective share, HARD_HUMAN share inside the human component (pool mined from
  TRAIN only), Spanish / academic weights, optional Stage-B emphasis mixture (additive per row, no double count);
* a fraction of training samples are single STRICT paragraphs (>=120 chars, >=20 words, >=32 tokens, no
  neighbours) next to 512/128 document windows;
* head-A loss: ce (BCE) | weighted (human weight > 1 penalises human false positives) | focal (gamma);
* checkpoints are selected on F006 VALIDATION with F006_SELECTION_SCORE (f006_lib), which penalises human FPR;
  the final holdout and the V1 historical sets are never read here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import multiprocessing as mp
import os
import random
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import evaluate_scores, log, set_score, write_json  # noqa: E402
from turniting_train import adapters_v2 as A  # noqa: E402
from turniting_train.canon import attack_homoglyph, attack_whitespace, attack_zero_width  # noqa: E402
from turniting_train.common import CONFIG_DIR, git_commit, hardware_info, library_versions, load_yaml, set_seed, utc_now  # noqa: E402
from turniting_train.sampling import weighted_sample  # noqa: E402
from turniting_train.v3model import FINE_TO_B, V3Detector, doc_windows  # noqa: E402
from v3_train import META, Collate, DriveSync, GpuMonitor, WindowData, auto_batch, epoch_batches, read_split  # noqa: E402

MIN_CHARS, MIN_WORDS, MIN_TOKENS = 120, 20, 32
WINDOWS_PER_DOC = 1.55  # measured on V3 caches
EDIT_LABELS = [A.MIXED, A.AI_EDITED, A.HUMAN_EDITED_AI]


# ------------------------------------------------------------------ sampling

def base_weights(meta: pd.DataFrame, dsw: dict, es_w: float, aca_w: float) -> np.ndarray:
    sig = (meta["fine_label"] != A.HUMAN).astype(int)
    key = meta["dataset"].astype(str) + "|" + sig.astype(str)
    counts = key.map(key.value_counts()).values
    w = meta["dataset"].astype(str).map(lambda d: dsw.get(d, dsw["default"])).astype(float).values / counts
    w *= np.where(meta["language"].astype(str) == "es", es_w, 1.0)
    w *= np.where(meta["domain"].astype(str) == "academic", aca_w, 1.0)
    return w


def norm(w: np.ndarray, mask: np.ndarray, mass: float) -> np.ndarray:
    out = np.zeros_like(w)
    s = w[mask].sum()
    if s > 0 and mass > 0:
        out[mask] = w[mask] / s * mass
    return out


def sampler_weights(meta: pd.DataFrame, hard: np.ndarray, sp: dict, a) -> tuple[np.ndarray, dict]:
    dsw = sp["dataset_weights"]
    human = (meta["fine_label"] == A.HUMAN).values
    adv = meta["is_adversarial"].values.astype(bool)
    w0 = base_weights(meta, dsw, a.es_w, a.aca_w)
    # hard rows get their own per-dataset normalisation (the pool is capped per dataset already)
    wh = w0.copy()
    if hard.any():
        hk = meta.loc[hard, "dataset"].astype(str)
        wh[hard] = hk.map(lambda d: dsw.get(d, dsw["default"])).astype(float).values / hk.map(hk.value_counts()).values
        wh[hard] *= np.where(meta.loc[hard, "language"].astype(str).values == "es", a.es_w, 1.0)
        wh[hard] *= np.where(meta.loc[hard, "domain"].astype(str).values == "academic", a.aca_w, 1.0)
    m_w = norm(w0, ~human, 1 - a.human_share)
    frac = m_w[adv].sum() / max(m_w.sum(), 1e-12)
    capf = sp["adversarial_cap"]
    if frac > capf:
        m_w[adv] *= capf * (1 - frac) / (frac * (1 - capf))
        m_w = norm(m_w, ~human, 1 - a.human_share)
    base = m_w + norm(w0, human & ~hard, a.human_share * (1 - a.hard_ratio)) + norm(wh, hard, a.human_share * a.hard_ratio)
    comp = {"base": 1.0}
    es = (meta["language"].astype(str) == "es").values
    es_hard = meta["es_hard"].values.astype(bool) if "es_hard" in meta else np.zeros(len(meta), bool)
    if a.es_mix:
        fh, fn, fg = a.es_mix
        hsh = a.human_share
        g_h = human & ~es
        base = (m_w + norm(wh, es_hard & human, hsh * fh) + norm(w0, es & human & ~es_hard, hsh * fn)
                + norm(w0, g_h & ~hard, hsh * fg * (1 - a.hard_ratio)) + norm(wh, g_h & hard, hsh * fg * a.hard_ratio))
        comp = {"base": 1.0, "human_component": {"spanish_hard": fh, "spanish_normal": fn, "global": fg}}
    if a.mixture == "f006_1_1":
        mix = dict(zip(["replay", "hard_human", "spanish_human", "mixed", "span", "ai_edited", "robustness"], a.mix))
        aca_hard = es_hard | hard
        has_span = meta["has_span"].values.astype(bool) if "has_span" in meta else np.zeros(len(meta), bool)
        mixed = meta["fine_label"].isin([A.MIXED, A.HUMAN_EDITED_AI]).values
        edited = meta["fine_label"].isin([A.AI_EDITED, A.PARAPHRASED_AI]).values
        total = base * mix["replay"]
        total += norm(wh, aca_hard & human, mix["hard_human"])
        total += norm(w0, es & human & ~aca_hard, mix["spanish_human"])
        total += norm(w0, mixed, mix["mixed"])
        total += norm(w0, has_span, mix["span"])
        total += norm(w0, edited, mix["ai_edited"])
        total += norm(w0, adv, mix["robustness"])
        return total, mix
    if a.stage == "full" and a.mixture == "f006_1":
        aca = (meta["domain"].astype(str) == "academic").values
        edit = meta["fine_label"].isin(EDIT_LABELS).values
        edit_ds = meta["dataset"].isin(meta.loc[edit, "dataset"].unique()).values
        multi = ~meta["language"].astype(str).isin(["en", "es"]).values
        pi = {"global_replay": 0.35, "spanish_human": 0.25, "spanish_machine": 0.15, "academic": 0.10, "generalization_multilingual": 0.05,
              "adversarial_unicode": 0.05, "mixed_edited_global": 0.05}
        fh = a.es_mix[0] / max(a.es_mix[0] + a.es_mix[1], 1e-9) if a.es_mix else a.hard_ratio
        total = base * pi["global_replay"]
        total += norm(wh, es_hard & human, pi["spanish_human"] * fh) + norm(w0, es & human & ~es_hard, pi["spanish_human"] * (1 - fh))
        total += norm(w0, es & ~human, pi["spanish_machine"])
        total += norm(w0, aca & human, pi["academic"] / 2) + norm(w0, aca & ~human, pi["academic"] / 2)
        total += norm(w0, multi & human, pi["generalization_multilingual"] / 2) + norm(w0, multi & ~human, pi["generalization_multilingual"] / 2)
        total += norm(w0, adv, pi["adversarial_unicode"])
        total += norm(w0, edit, pi["mixed_edited_global"] / 2) + norm(w0, edit_ds & human, pi["mixed_edited_global"] / 2)
        return total, pi
    if a.stage == "full" and a.emphasis:
        es = (meta["language"].astype(str) == "es").values
        aca = (meta["domain"].astype(str) == "academic").values
        edit = meta["fine_label"].isin(EDIT_LABELS).values
        edit_ds = meta["dataset"].isin(meta.loc[edit, "dataset"].unique()).values
        pi = {"base": 0.70, "spanish": 0.10, "academic": 0.10, "mixed_edited": 0.05, "robustness": 0.05}
        total = base * pi["base"]
        total += norm(w0, es & human, pi["spanish"] / 2) + norm(w0, es & ~human, pi["spanish"] / 2)
        total += norm(w0, aca & human, pi["academic"] / 2) + norm(w0, aca & ~human, pi["academic"] / 2)
        total += norm(w0, edit, pi["mixed_edited"] / 2) + norm(w0, edit_ds & human, pi["mixed_edited"] / 2)
        total += norm(w0, adv, pi["robustness"])
        return total, pi
    return base, comp


# ------------------------------------------------------------------ paragraphs + tokenization workers

_TOK = None
_TCFG: dict = {}
_BLOCK = re.compile(r"\S[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*")
_LINE = re.compile(r"\S[^\n]*")
_SENT = re.compile(r"[^.!?。！？]+[.!?。！？]+[\"'”’)\]]*|\S[^.!?。！？]*$")


def para_spans(text: str) -> list[tuple[int, int]]:
    spans = [(m.start(), m.end()) for m in _BLOCK.finditer(text)]
    if len(spans) <= 1:
        spans = [(m.start(), m.end()) for m in _LINE.finditer(text)]
    if len(spans) <= 1:  # no line structure: groups of sentences (~60-150 words)
        sents = [(m.start(), m.end()) for m in _SENT.finditer(text)]
        spans, cur, words = [], None, 0
        for s, e in sents:
            cur = (cur[0], e) if cur else (s, e)
            words += len(text[s:e].split())
            if words >= 60:
                spans.append(cur)
                cur, words = None, 0
        if cur:
            spans.append(cur)
    out = []
    for s, e in spans:
        seg = text[s:e]
        lead = len(seg) - len(seg.lstrip())
        seg = seg.strip()
        if len(seg) >= MIN_CHARS and len(seg.split()) >= MIN_WORDS:
            out.append((s + lead, s + lead + len(seg)))
    return out


def _init_tok(path, tcfg):
    global _TOK, _TCFG
    from transformers import AutoTokenizer

    _TOK = AutoTokenizer.from_pretrained(path)
    _TCFG = tcfg


def _labels_from_frac(fine: str, frac: float) -> tuple[int, int]:
    b_doc = FINE_TO_B[fine]
    if fine == A.HUMAN:
        return 0, 0
    if frac <= 0.05:
        return 0, 0
    if frac >= 0.9:
        return 1, (2 if b_doc == 2 else 1)
    return 1, 3


def _span_mask(spans, n):
    mask = np.zeros(n + 1, np.int32)
    for s, e, *_ in spans:
        mask[max(0, s):min(n, e)] = 1
    return np.concatenate([[0], np.cumsum(mask)])


def _paragraph_sample(d, text, spans, rng):
    fine = d["fine_label"]
    if fine == A.MIXED and spans is None:
        return None
    cands = para_spans(text)
    if not cands:
        return None
    ps, pe = rng.choice(cands)
    seg = text[ps:pe]
    enc = _TOK(seg, add_special_tokens=False, truncation=True, max_length=_TCFG["max_length"] - 2,
               return_offsets_mapping=spans is not None)
    ids = enc["input_ids"]
    if len(ids) < MIN_TOKENS:
        return None
    tl = None
    if spans is not None:
        cum = _span_mask(spans, len(text))
        offs = enc["offset_mapping"]
        lab = np.array([1 if cum[min(ps + e, len(text))] - cum[min(ps + s, len(text))] > 0 else 0 for s, e in offs], np.int8)
        a, b = _labels_from_frac(fine, float(lab.mean()) if len(lab) else 0.0)
        tl = np.concatenate([[-100], lab, [-100]]).astype(np.int8)
    else:
        a, b = int(fine != A.HUMAN), FINE_TO_B[fine]
    return [(d["id"], np.asarray([_TOK.cls_token_id] + ids + [_TOK.sep_token_id], np.int32), a, b, tl, "paragraph")]


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
        if rng.random() < _TCFG["paragraph_doc_prob"]:
            ps = _paragraph_sample(d, text, spans, rng)
            if ps is not None:
                out.extend((i, ids, a, b, tl, f"{view}|paragraph") for i, ids, a, b, tl, _ in ps)
                continue
        ws, offs = doc_windows(_TOK, text, _TCFG["max_length"], _TCFG["stride"], None, offsets=spans is not None)
        if len(ws) > _TCFG["windows_per_doc"]:
            ws = [ws[0]] + rng.sample(ws[1:], _TCFG["windows_per_doc"] - 1)
        fine = d["fine_label"]
        a_doc, b_doc = int(fine != A.HUMAN), FINE_TO_B[fine]
        tok_lab = None
        if spans is not None:
            cum = _span_mask(spans, len(text))
            tok_lab = np.array([1 if cum[min(e, len(text))] - cum[min(s, len(text))] > 0 else 0 for s, e in offs], np.int8)
        for ids, (ts, te) in ws:
            a, b, tl = a_doc, b_doc, None
            if tok_lab is not None:
                part = tok_lab[ts:te]
                tl = np.concatenate([[-100], part, [-100]]).astype(np.int8)
                if fine != A.HUMAN:
                    a, b = _labels_from_frac(fine, float(part.mean()) if len(part) else 0.0)
            out.append((d["id"], np.asarray(ids, np.int32), a, b, tl, f"{view}|window"))
    return out


def cache_key(a) -> str:
    keys = ["windows", "human_share", "hard_ratio", "es_w", "aca_w", "para_frac", "stage", "emphasis", "hard_pool", "seed",
            "es_mix", "es_hard_pool", "train_extra", "mixture", "mix"]
    s = json.dumps({k: getattr(a, k) for k in keys}, sort_keys=True, default=str)
    return hashlib.sha256(s.encode()).hexdigest()[:12]


def build_cache(a, cfg, tok_path, cache: Path) -> dict:
    if (cache / "meta.parquet").exists():
        log(f"cache hit {cache}")
        return json.loads((cache / "audit.json").read_text())
    t0 = time.time()
    master = Path(a.master)
    meta = read_split(master, "train", META)
    extra = None
    if a.train_extra:
        extra = pd.read_parquet(a.train_extra)
        meta = pd.concat([meta, extra[META]], ignore_index=True)
    meta = meta[meta["fine_label"].isin(list(FINE_TO_B))]
    n_dup = int(meta["id"].duplicated().sum())
    if n_dup:  # a duplicated id would duplicate rows in the window-meta merge and shift every label after it
        log(f"dropping {n_dup:,} duplicated train ids")
    meta = meta.drop_duplicates("id").reset_index(drop=True)
    if a.es_hard_pool:
        meta["es_hard"] = meta["id"].isin(set(pd.read_parquet(a.es_hard_pool, columns=["id"])["id"])).values
    if a.mixture == "f006_1_1":
        spidx = pd.read_parquet("/content/drive/MyDrive/turniting/v3/datasets/index_v2.parquet", columns=["id", "span_labels_present", "split"])
        span_ids = set(spidx.loc[(spidx["split"] == "train") & spidx["span_labels_present"].fillna(False).astype(bool), "id"])
        if extra is not None:
            span_ids |= set(extra.loc[extra["span_labels"].notna(), "id"])
        meta["has_span"] = meta["id"].isin(span_ids).values
    pool = pd.read_parquet(a.hard_pool, columns=["id"]) if a.hard_pool else pd.DataFrame({"id": []})
    hard = meta["id"].isin(set(pool["id"])).values & (meta["fine_label"] == A.HUMAN).values
    w, comp = sampler_weights(meta, hard, cfg["sampling"], a)
    n_docs = int(a.windows / (WINDOWS_PER_DOC * (1 - a.para_frac) + a.para_frac)) + 1
    docs = weighted_sample(meta, w, n_docs, a.seed).sample(frac=1.0, random_state=a.seed)
    docs = docs.assign(hard_human=docs["id"].isin(set(pool["id"])))
    log(f"sampled {len(docs):,} docs ({int(docs['hard_human'].sum()):,} hard humans) from {len(meta):,} train rows")
    tcols = ["id", "text_original", "text_normalized", "fine_label", "span_labels"]
    in_extra = docs["id"].isin(set(extra["id"])) if extra is not None else pd.Series(False, index=docs.index)
    parts = [read_split(master, "train", tcols, ids=docs.loc[~in_extra, "id"].tolist())]
    if extra is not None and in_extra.any():
        parts.append(extra.loc[extra["id"].isin(set(docs.loc[in_extra, "id"])), tcols])
    texts = pd.concat(parts, ignore_index=True).drop_duplicates("id").set_index("id").loc[docs["id"]].reset_index()
    recs = texts.to_dict("records")
    del texts
    q = a.para_frac * WINDOWS_PER_DOC / (1 - a.para_frac + a.para_frac * WINDOWS_PER_DOC)
    tcfg = {"max_length": cfg["max_length"], "stride": cfg["stride"], "windows_per_doc": cfg["windows_per_doc"],
            "canonical_view_prob": cfg["canonical_view_prob"], "attack_prob": cfg["attack_prob"], "seed": a.seed,
            "paragraph_doc_prob": q}
    jobs = [recs[i:i + 500] for i in range(0, len(recs), 500)]
    rows = []
    ctx = mp.get_context("fork" if "fork" in mp.get_all_start_methods() else "spawn")
    with ctx.Pool(a.workers, initializer=_init_tok, initargs=(tok_path, tcfg)) as pool_:
        for k, res in enumerate(pool_.imap(_tok_docs, jobs)):
            rows.extend(res)
            if len(rows) >= a.windows:
                break
            if k % 100 == 0:
                log(f"  tokenized {len(rows):,} samples")
    rows = rows[: a.windows]
    cache.mkdir(parents=True, exist_ok=True)
    lens = np.array([len(r[1]) for r in rows], np.int32)
    np.save(cache / "tokens.npy", np.concatenate([r[1] for r in rows]).astype(np.int32))
    np.save(cache / "lens.npy", lens)
    tl_len = np.array([0 if r[4] is None else len(r[4]) for r in rows], np.int32)
    np.save(cache / "toklab.npy", np.concatenate([r[4] for r in rows if r[4] is not None] or [np.zeros(0, np.int8)]).astype(np.int8))
    np.save(cache / "toklab_lens.npy", tl_len)
    wm = pd.DataFrame({"doc_id": [r[0] for r in rows], "a": [r[2] for r in rows], "b": [r[3] for r in rows],
                       "view": [r[5] for r in rows], "len": lens})
    wm["unit"] = wm["view"].str.split("|").str[-1]
    wm = wm.merge(docs[META + ["hard_human"]].drop_duplicates("id").rename(columns={"id": "doc_id"}), on="doc_id", how="left")
    if len(wm) != len(rows):
        raise SystemExit(f"ABORT: window meta {len(wm)} != windows {len(rows)} (labels would be misaligned)")
    wm.to_parquet(cache / "meta.parquet", index=False)
    audit = {
        "cache_key": cache.name, "stage": a.stage, "training_windows": int(len(wm)), "training_docs": int(wm["doc_id"].nunique()),
        "machine_signal_share": float(wm["a"].mean()), "human_share_windows": float(1 - wm["a"].mean()),
        "hard_human_windows": int(wm["hard_human"].sum()), "hard_share_of_human_windows": float(wm.loc[wm["a"] == 0, "hard_human"].mean()),
        "paragraph_windows": int((wm["unit"] == "paragraph").sum()), "paragraph_share": float((wm["unit"] == "paragraph").mean()),
        "fine_head_distribution": wm["b"].value_counts().sort_index().tolist(),
        "spanish_windows": int((wm["language"] == "es").sum()), "academic_windows": int((wm["domain"] == "academic").sum()),
        "span_labeled_windows": int((tl_len > 0).sum()), "adversarial_windows": int(wm["is_adversarial"].sum()),
        "views": wm["view"].value_counts().to_dict(), "mean_tokens": float(lens.mean()), "mixture": comp,
        "sampling": {"human_share": a.human_share, "hard_ratio": a.hard_ratio, "es_w": a.es_w, "aca_w": a.aca_w,
                     "para_frac": a.para_frac, "hard_pool": a.hard_pool},
        "by_dataset": wm.groupby("dataset")["a"].agg(["size", "mean"]).round(3).rename(columns={"size": "windows", "mean": "machine"}).to_dict("index"),
        "seconds": round(time.time() - t0, 1),
    }
    write_json(cache / "audit.json", audit)
    log(f"cache built: {len(wm):,} samples ({audit['paragraph_share']:.1%} paragraphs, human {audit['human_share_windows']:.1%}, "
        f"hard {audit['hard_share_of_human_windows']:.1%} of human) in {audit['seconds']}s")
    return audit


# ------------------------------------------------------------------ evaluation on F006 VALIDATION

def doc_logits(model, tok, texts: list[str], icfg: dict, device) -> np.ndarray:
    from f006_score import doc_logits as fast

    return fast(model, tok, texts, icfg.get("view", "canonical"), icfg.get("aggregation", "mean"),
                icfg.get("max_windows_per_doc", 8), device=device)


def run_eval(model, tok, val: pd.DataFrame, icfg, device) -> tuple[dict, np.ndarray]:
    lg = doc_logits(model, tok, val["text_original"].tolist(), icfg, device)
    p = 1 / (1 + np.exp(-lg))
    if "span_labels" in val and (val["primary"] == "span").any():
        from f006_lib import selection_score
        from f0611_span import span_eval

        sp = val[(val["primary"] == "span") & val["span_labels"].notna()].head(800)
        ev = evaluate_scores(val, p)
        ev["subsets"]["span_head"] = span_eval(model, tok, sp["text_original"].tolist(), sp["span_labels"].tolist(), device=device)
        ev["selection"] = selection_score(ev["subsets"])
        return ev, lg
    return evaluate_scores(val, p), lg


def brief(ev: dict) -> str:
    s, sub = ev["selection"], ev["subsets"]
    f = lambda k, m: (None if sub.get(k, {}).get(m) is None else round(sub[k][m], 3))  # noqa: E731
    return (f"score={s['score']:.4f} elig={s['eligible']} thr={ev['threshold_general_fpr_0.04']} fpr_all={f('all', 'fpr')} "
            f"es={f('spanish', 'macro_f1')}/{f('spanish', 'fpr')} aca={f('academic', 'macro_f1')}/{f('academic', 'fpr')} "
            f"ugen={f('unseen_generator', 'recall')}/{f('unseen_generator', 'fpr')} mixed={f('mixed', 'recall')} "
            f"edit={f('ai_edited', 'macro_f1')} ood={f('ood', 'macro_f1')}/{f('ood', 'fpr')} hard_fpr={f('hard_human', 'fpr')}")


# ------------------------------------------------------------------ main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--stage", choices=["ablation", "full"], default="ablation")
    ap.add_argument("--windows", type=int, default=150000)
    ap.add_argument("--human-share", type=float, default=0.5)
    ap.add_argument("--hard-ratio", type=float, default=0.3)
    ap.add_argument("--es-w", type=float, default=None)
    ap.add_argument("--aca-w", type=float, default=None)
    ap.add_argument("--para-frac", type=float, default=0.25)
    ap.add_argument("--emphasis", action="store_true", help="full stage: 70/10/10/5/5 mixture")
    ap.add_argument("--loss", choices=["ce", "weighted", "focal"], default="ce")
    ap.add_argument("--human-weight", type=float, default=1.0)
    ap.add_argument("--focal-gamma", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=1.0e-5)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--eval-every", type=int, default=0, help="steps; 0 = only at the end")
    ap.add_argument("--min-epochs-before-stop", type=float, default=0.75)
    ap.add_argument("--patience", type=int, default=3)
    ap.add_argument("--seed", type=int, default=6006)
    ap.add_argument("--init", default="/content/drive/MyDrive/turniting/v3/checkpoints/20261017_0604_v3_es_acad/best")
    ap.add_argument("--icfg-from", default="/content/drive/MyDrive/turniting/v3/models/spanish_academic/inference_config.json")
    ap.add_argument("--hard-pool", default="/content/drive/MyDrive/turniting/f006/datasets/hard_human_pool_v1.parquet")
    ap.add_argument("--es-hard-pool", default=None)
    ap.add_argument("--es-mix", default=None, help="Spanish-hard,Spanish-normal,global shares of the human component, e.g. 0.4,0.3,0.3")
    ap.add_argument("--train-extra", default=None)
    ap.add_argument("--mixture", default="f006", choices=["f006", "f006_1", "f006_1_1"])
    ap.add_argument("--mix", default="0.30,0.25,0.15,0.10,0.10,0.05,0.05", help="f006_1_1: replay,hard,spanish,mixed,span,edited,robust")
    ap.add_argument("--token-weight", type=float, default=None, help="override head-C loss weight (multi-task ablation)")
    ap.add_argument("--score", default="f006", choices=["f006", "f006_1", "f006_1_1"])
    ap.add_argument("--master", default="/content/f006work/master_v2")
    ap.add_argument("--val", default="/content/drive/MyDrive/turniting/f006/datasets/f006_validation.parquet")
    ap.add_argument("--drive", default="/content/drive/MyDrive/turniting/f006")
    ap.add_argument("--local", default="/content/turniting-f006/ckpt")
    ap.add_argument("--cache-root", default="/content/turniting-f006/cache")
    ap.add_argument("--workers", type=int, default=max(1, min((os.cpu_count() or 2) - 1, 11)))
    ap.add_argument("--max-steps", type=int)
    ap.add_argument("--val-cap", type=int, help="smoke tests only")
    a = ap.parse_args()
    a.es_mix = tuple(float(x) for x in a.es_mix.split(",")) if a.es_mix else None
    a.mix = tuple(float(x) for x in a.mix.split(","))
    set_score(a.score)
    cfg = load_yaml(CONFIG_DIR / "v3.yaml")["train"]
    sel = json.loads(Path("/content/drive/MyDrive/turniting/v3/manifests/weight_selection.json").read_text()) \
        if Path("/content/drive/MyDrive/turniting/v3/manifests/weight_selection.json").exists() else {}
    a.es_w = a.es_w if a.es_w is not None else sel.get("spanish_weight", cfg["sampling"]["spanish_weight"])
    a.aca_w = a.aca_w if a.aca_w is not None else sel.get("academic_weight", cfg["sampling"]["academic_weight"])
    a.hard_pool = a.hard_pool if a.hard_ratio > 0 else None
    set_seed(a.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    run_dir = Path(a.drive) / "runs" / a.run
    run_dir.mkdir(parents=True, exist_ok=True)
    if (run_dir / "run.json").exists():
        log(f"{a.run} already finished; skipping")
        return 0
    local = Path(a.local) / a.run
    local.mkdir(parents=True, exist_ok=True)
    from transformers import AutoTokenizer, get_linear_schedule_with_warmup

    tok_path = str(Path(a.init) / "backbone")
    tok = AutoTokenizer.from_pretrained(tok_path)
    cache = Path(a.cache_root) / cache_key(a)
    audit = build_cache(a, cfg, tok_path, cache)
    write_json(run_dir / "sample_audit.json", audit)
    icfg = json.loads(Path(a.icfg_from).read_text())
    val = pd.read_parquet(a.val)
    if a.val_cap:
        val = val.groupby("primary", group_keys=False).apply(lambda g: g.head(a.val_cap))
    log(f"{a.run}: stage={a.stage} loss={a.loss} hw={a.human_weight} h={a.human_share} r={a.hard_ratio} es={a.es_w} "
        f"aca={a.aca_w} para={a.para_frac} lr={a.lr}; validation {len(val):,} docs; view={icfg.get('view')} agg={icfg.get('aggregation')}")

    model = V3Detector.load(a.init).to(device)
    probe = auto_batch(model, device, cfg["max_length"], 0.84, candidates=(32, 40, 48, 56, 64, 80, 96, 112, 128)) \
        if device.type == "cuda" else {"micro_batch": 4}
    micro = probe["micro_batch"]
    accum = max(1, round(cfg["effective_batch"] / micro))
    write_json(run_dir / "auto_batch.json", {**probe, "accumulation": accum, "effective_batch": micro * accum})
    log(f"micro batch {micro} x accum {accum} = effective {micro * accum}")

    data = WindowData(cache)
    steps_per_epoch = math.ceil(len(data) / (micro * accum))
    total = steps_per_epoch * a.epochs
    eval_every = a.eval_every or total
    decay = [p for n, p in model.named_parameters() if not (p.ndim < 2 or "LayerNorm" in n or "bias" in n)]
    no_decay = [p for n, p in model.named_parameters() if (p.ndim < 2 or "LayerNorm" in n or "bias" in n)]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": cfg["weight_decay"]}, {"params": no_decay, "weight_decay": 0.0}],
                            lr=a.lr, fused=device.type == "cuda")
    sched = get_linear_schedule_with_warmup(opt, int(total * cfg["warmup_ratio"]), total)
    step, best, bad, history = 0, -1e9, 0, []
    drive_last = run_dir / "last"
    if a.stage == "full" and (drive_last / "trainer_state.pt").exists():
        shutil.copytree(drive_last, local / "last", dirs_exist_ok=True)
        model.load_state_dict(V3Detector.load(local / "last").state_dict())
        st = torch.load(local / "last" / "trainer_state.pt", weights_only=False)
        opt.load_state_dict(st["optimizer"]); sched.load_state_dict(st["scheduler"])
        step, best, bad, history = st["step"], st["best"], st["bad"], st["history"]
        log(f"resumed at step {step} (best {best:.4f})")

    # step-0 reference: the V3 init on F006 validation (same code path, no training)
    if not history:
        tag = "V3_INIT" if "v3" in str(a.init) else "INIT_" + hashlib.sha256(str(a.init).encode()).hexdigest()[:8]
        ref = Path(a.drive) / "runs" / f"{tag}_validation{'_cap' if a.val_cap else ''}.json"
        if ref.exists():
            ev0 = json.loads(ref.read_text())
        else:
            ev0, lg0 = run_eval(model, tok, val, icfg, device)
            write_json(ref, ev0)
            pd.DataFrame({"id": val["id"].values, "label": val["label"].values, "logit": lg0}).to_parquet(
                ref.with_suffix(".parquet"), index=False)
        log(f"  EVAL step 0 (V3 init): {brief(ev0)}")
        history.append({"step": 0, "epoch": 0.0, **ev0})

    hw = dict(cfg["heads"])
    if a.token_weight is not None:
        hw["token_weight"] = a.token_weight
    bce = torch.nn.BCEWithLogitsLoss(reduction="none")
    ce = torch.nn.CrossEntropyLoss()

    def loss_a(logit, y):
        l_ = bce(logit, y)
        if a.loss == "weighted":
            w = torch.where(y < 0.5, torch.full_like(y, a.human_weight), torch.ones_like(y))
            return (w * l_).sum() / w.sum()
        if a.loss == "focal":
            pt = torch.exp(-l_)
            return ((1 - pt) ** a.focal_gamma * l_).mean()
        return l_.mean()

    sync, mon = DriveSync(), GpuMonitor()
    mon.start()
    t0, seen, stop = time.time(), 0, False
    collate = Collate(tok.pad_token_id)
    model.train()
    for epoch in range(a.epochs):
        batches = epoch_batches(data.lens, micro, a.seed, epoch)
        groups = [batches[i:i + accum] for i in range(0, len(batches), accum)]
        start_group = max(0, step - epoch * steps_per_epoch)
        if start_group >= len(groups):
            continue
        flat = [b for g in groups[start_group:] for b in g]
        loader = torch.utils.data.DataLoader(data, batch_sampler=flat, collate_fn=collate, num_workers=min(a.workers, 8),
                                             pin_memory=True, persistent_workers=True, prefetch_factor=4)
        it = iter(loader)
        for g in groups[start_group:]:
            tot = {"a": 0.0, "b": 0.0, "c": 0.0}
            for _ in g:
                batch = next(it)
                ids = batch["input_ids"].to(device, non_blocking=True)
                mask = batch["attention_mask"].to(device, non_blocking=True)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    out = model(ids, mask)
                la = loss_a(out["a"].float(), batch["a"].to(device))
                lb = ce(out["b"].float(), batch["b"].to(device))
                tl = batch["c"].to(device)
                valid = tl != -100
                lc = bce(out["c"].float()[valid], tl[valid].float()).mean() if valid.any() else torch.zeros((), device=device)
                loss = (hw["binary_weight"] * la + hw["fine_weight"] * lb + hw["token_weight"] * lc) / len(g)
                if not torch.isfinite(loss):
                    raise RuntimeError(f"ABORT: non-finite loss at step {step}")
                loss.backward()
                tot["a"] += float(la) / len(g); tot["b"] += float(lb) / len(g); tot["c"] += float(lc) / len(g)
                seen += ids.shape[0]
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
            step += 1
            if step % 50 == 0:
                el = time.time() - t0
                log(f"  step {step}/{total} ep {step / steps_per_epoch:.2f} loss a={tot['a']:.4f} b={tot['b']:.4f} c={tot['c']:.4f} "
                    f"lr={sched.get_last_lr()[0]:.2e} {seen / el:.0f} win/s mem={torch.cuda.max_memory_allocated() / 1e9 if device.type == 'cuda' else 0:.1f}GB")
            last_step = step == total or (a.max_steps and step >= a.max_steps)
            if step % eval_every == 0 or last_step:
                ev, lg = run_eval(model, tok, val, icfg, device)
                model.train()
                rec = {"step": step, "epoch": round(step / steps_per_epoch, 3), **ev, "elapsed_s": round(time.time() - t0, 1),
                       "gpu": mon.summary()}
                history.append(rec)
                log(f"  EVAL step {step}: {brief(ev)}")
                s = ev["selection"]["score"] - (0 if ev["selection"]["eligible"] else 1.0)
                if s > best:
                    best, bad = s, 0
                    model.save(local / "best", tok, {"step": step, "selection_score": s, "run": a.run})
                    (local / "best" / "inference_config.json").write_text(json.dumps(icfg, indent=2))
                    sync.push(local / "best", run_dir / "best")
                    sync.wait()
                    pd.DataFrame({"id": val["id"].values, "label": val["label"].values, "logit": lg}).to_parquet(
                        run_dir / "validation_doc_logits.parquet", index=False)
                elif step / steps_per_epoch >= a.min_epochs_before_stop:
                    bad += 1
                if a.stage == "full":
                    model.save(local / "last", tok, {"step": step})
                    torch.save({"optimizer": opt.state_dict(), "scheduler": sched.state_dict(), "step": step, "best": best,
                                "bad": bad, "history": history}, local / "last" / "trainer_state.pt")
                    sync.push(local / "last", drive_last)
                with open(run_dir / "train_log.jsonl", "a") as fh:
                    fh.write(json.dumps({k: v for k, v in rec.items() if k != "subsets"}, default=str) + "\n")
                if bad >= a.patience:
                    log("early stopping on F006_SELECTION_SCORE"); stop = True
                if a.max_steps and step >= a.max_steps:
                    stop = True
            if stop:
                break
        del loader, it
        if stop:
            break
    sync.wait()
    mon.stop_flag = True
    train_s = time.time() - t0
    best_rec = max(history[1:] or history, key=lambda r: r["selection"]["score"] - (0 if r["selection"]["eligible"] else 1.0))
    write_json(run_dir / "run.json", {
        "run": a.run, "stage": a.stage, "timestamp": utc_now(), "gitCommit": git_commit(), "init": a.init,
        "config": {k: getattr(a, k) for k in ("windows", "human_share", "hard_ratio", "es_w", "aca_w", "para_frac", "emphasis",
                                               "loss", "human_weight", "focal_gamma", "lr", "epochs", "seed", "hard_pool",
                                               "es_mix", "es_hard_pool", "train_extra", "mixture", "score", "mix", "token_weight")},
        "sampleAudit": {k: v for k, v in audit.items() if k != "by_dataset"}, "microBatch": micro, "accumulation": accum,
        "stepsPerEpoch": steps_per_epoch, "totalSteps": total, "stoppedAtStep": step, "trainSeconds": round(train_s, 1),
        "throughputWindowsPerSec": round(seen / max(train_s, 1), 1), "gpuMonitor": mon.summary(),
        "peakVramGb": round(torch.cuda.max_memory_allocated() / 1e9, 2) if device.type == "cuda" else None,
        "hardware": hardware_info(), "versions": library_versions(), "autoBatch": probe,
        "v3_init_validation": history[0], "best": best_rec, "history": [{k: v for k, v in h.items() if k != "subsets"} for h in history],
    })
    log(f"done {a.run}: best {brief(best_rec)} ({train_s / 60:.1f} min, {seen / max(train_s, 1):.0f} win/s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
