"""Adapters for the new TURNITING_DATASET_V2 sources (raw files -> V2 records).

Every adapter yields dicts with the V2 fields:
  text (exactly as published: span offsets refer to it), binary_label (0 HUMAN / 1 MACHINE /
  None when not purely one or the other), fine_label, ai_fraction, language, raw_domain,
  generator_raw, dataset, subset, source_id, group_key, parent_id, attack, edit_type,
  is_mixed, is_adversarial, span_labels, sentence_labels, original_split, role, metadata

fine_label: HUMAN, AI_GENERATED, AI_EDITED (human text rewritten/polished by AI),
HUMAN_EDITED_AI (AI text edited by a person), MIXED (human and AI segments), PARAPHRASED_AI
(AI text rewritten by AI / adversarial paraphrase), UNKNOWN.
`group_key` ties every variant of one human source / prompt / question together.
`role`: official_test (forces the group to the evaluation side), adversarial_only (attack
variants never trained on), eval_only (whole source reserved for evaluation).
"""

from __future__ import annotations

import ast
import csv
import gc
import hashlib
import io
import json
import pickle
import re
import zipfile
from collections.abc import Iterator
from pathlib import Path

import pandas as pd

csv.field_size_limit(2**31 - 1)

HUMAN, AI_GENERATED, AI_EDITED, HUMAN_EDITED_AI = "HUMAN", "AI_GENERATED", "AI_EDITED", "HUMAN_EDITED_AI"
MIXED, PARAPHRASED_AI, UNKNOWN = "MIXED", "PARAPHRASED_AI", "UNKNOWN"
FINE_LABELS = [HUMAN, AI_GENERATED, AI_EDITED, HUMAN_EDITED_AI, MIXED, PARAPHRASED_AI, UNKNOWN]
PURE_BINARY = {HUMAN: 0, AI_GENERATED: 1, PARAPHRASED_AI: 1}

LANG_NAMES = {"arabic": "ar", "chinese": "zh", "english": "en", "french": "fr", "german": "de",
              "portuguese": "pt", "russian": "ru", "spanish": "es", "eng": "en", "en-en": "en"}


def h(text: str, n: int = 16) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:n]


def rec(text, fine, dataset, **kw) -> dict:
    base = {
        "text": text, "fine_label": fine, "binary_label": PURE_BINARY.get(fine), "ai_fraction": None,
        "language": "en", "raw_domain": None, "generator_raw": "human" if fine == HUMAN else None,
        "dataset": dataset, "subset": None, "source_id": None, "group_key": None, "parent_id": None,
        "attack": "none", "edit_type": None, "is_mixed": fine == MIXED, "is_adversarial": False,
        "span_labels": None, "sentence_labels": None, "original_split": None, "role": None, "metadata": {},
    }
    base.update(kw)
    if base["ai_fraction"] is None:
        base["ai_fraction"] = 0.0 if fine == HUMAN else (1.0 if fine in (AI_GENERATED, PARAPHRASED_AI, AI_EDITED) else None)
    return base


def _s(v):
    if v is None or (isinstance(v, float) and v != v):
        return None
    return str(v)


# ------------------------------------------------------------------ MGTBench 2.0 / MGT-Academic

MGT_TOPIC = {
    "Physics": "STEM", "Medicine": "STEM", "Biology": "STEM", "Electrical_engineering": "STEM",
    "Computer_science": "STEM", "Math": "STEM", "Statistics": "STEM", "Chemistry": "STEM",
    "Literature": "Humanities", "History": "Humanities", "Education": "Social_sciences", "Art": "Humanities",
    "Law": "Social_sciences", "Management": "Social_sciences", "Philosophy": "Humanities", "Economy": "Social_sciences",
}


def mgtbench2_academic(root: Path) -> Iterator[dict]:
    # domain is "academic" for both classes on purpose: MGT-Academic is an academic-writing
    # benchmark and a label-dependent domain would be a shortcut.
    for f in sorted((root / "Human").rglob("*.json")):
        cat = f.parent.name
        src = f.stem.replace(f"{cat}_", "").replace("_new", "")
        for i, r in enumerate(json.loads(f.read_text(encoding="utf-8"))):
            text = r.get("text") or ""
            rid = r.get("id", i)
            yield rec(text, HUMAN, "mgtbench2_academic", raw_domain="academic", subset=f"human_{src}",
                      source_id=f"{cat}:{src}:{rid}", group_key=f"mgt:{cat}:{rid}",
                      metadata={"category": cat, "topic": MGT_TOPIC.get(cat), "source": src})
    for d in sorted(p for p in root.iterdir() if p.is_dir() and p.name.endswith("_new")):
        model = d.name[:-4]
        for f in sorted(d.glob("*.json")):
            cat = f.stem.replace("_task3", "")
            for i, r in enumerate(json.loads(f.read_text(encoding="utf-8"))):
                rid = r.get("id", i)
                yield rec(r.get("text") or "", AI_EDITED, "mgtbench2_academic", raw_domain="academic",
                          generator_raw=model, subset="task3_polish", edit_type="polish",
                          source_id=f"{cat}:{model}:{rid}", group_key=f"mgt:{cat}:{rid}",
                          metadata={"category": cat, "topic": MGT_TOPIC.get(cat), "task": "task3"})
        gc.collect()


# ------------------------------------------------------------------ MGTPD (gated, schema checked at runtime)

def mgtpd(root: Path) -> Iterator[dict]:
    for f in sorted(root.glob("*.csv")):
        split = f.stem.split("-")[-1].lower()
        for chunk in pd.read_csv(f, dtype=str, keep_default_na=False, chunksize=100_000):
            cols = {c.lower(): c for c in chunk.columns}
            tcol = next((cols[c] for c in ("text", "content", "sentence", "document") if c in cols), None)
            if tcol is None:
                raise ValueError(f"MGTPD: no text column in {list(chunk.columns)}")
            lcol = next((cols[c] for c in ("label", "labels", "class") if c in cols), None)
            langc = next((cols[c] for c in ("lang", "language") if c in cols), None)
            genc = next((cols[c] for c in ("model", "generator", "source_model") if c in cols), None)
            tokc = next((cols[c] for c in ("token_labels", "tags", "word_labels") if c in cols), None)
            for row in chunk.to_dict("records"):
                lab = str(row.get(lcol, "")).strip().lower() if lcol else ""
                toks = row.get(tokc) if tokc else None
                frac = None
                if toks:
                    try:
                        seq = [int(x) for x in re.findall(r"-?\d+", toks)]
                        frac = (sum(1 for x in seq if x > 0) / len(seq)) if seq else None
                    except ValueError:
                        frac = None
                if frac is not None:
                    fine = HUMAN if frac == 0 else (AI_GENERATED if frac == 1 else MIXED)
                elif lab in ("0", "human", "human-written"):
                    fine = HUMAN
                elif lab in ("1", "ai", "machine", "generated"):
                    fine = AI_GENERATED
                elif "mix" in lab or "partial" in lab:
                    fine = MIXED
                else:
                    fine = UNKNOWN
                text = row[tcol]
                yield rec(text, fine, "mgtpd", language=LANG_NAMES.get(str(row.get(langc, "")).lower(), row.get(langc) or None),
                          generator_raw=row.get(genc) if fine != HUMAN else "human", ai_fraction=frac,
                          original_split=split, group_key=f"mgtpd:{h(text)}",
                          role="official_test" if split == "test" else None,
                          metadata={"label_raw": lab, "token_labels_present": bool(toks)})


# ------------------------------------------------------------------ DetectRL-X

def _drlx_rows(path: Path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    yield from data
    del data
    gc.collect()


def detectrl_x(root: Path, test_machine_cap_per_strategy: int = 8000) -> Iterator[dict]:
    """Train (and general test) from the *general* files; the other strategies contribute
    only their (transformed) machine test texts, as adversarial / robustness evaluation."""
    seen_train_pairs = set()
    tern = root / "Ternary" / "trinary_general_open.json"
    for name, path in (("ternary_general", tern), ("binary_general", root / "Binary" / "binary_general_open.json")):
        if not path.exists():
            continue
        for r in _drlx_rows(path):
            human = r.get("human_written_text") or ""
            key = f"drlx:{h(human)}"
            split = r.get("split")
            lang = LANG_NAMES.get(str(r.get("lang", "")).lower(), r.get("lang"))
            common = dict(language=lang, raw_domain=r.get("domain"), original_split=split, group_key=key,
                          subset=name, role="official_test" if split == "test" else None,
                          metadata={"model": r.get("model"), "domain": r.get("domain")})
            pair_id = (key, r.get("model"))
            if name == "binary_general" and pair_id in seen_train_pairs:
                continue  # same pair already taken from the ternary file
            seen_train_pairs.add(pair_id)
            yield rec(human, HUMAN, "detectrl_x", **common)
            yield rec(r.get("llm_generated_text") or "", AI_GENERATED, "detectrl_x", generator_raw=r.get("model"),
                      parent_id=key, **common)
            if r.get("llm_refined_text"):
                yield rec(r["llm_refined_text"], PARAPHRASED_AI, "detectrl_x", generator_raw=r.get("model"),
                          edit_type="llm_refined", parent_id=key, **common)
    for path in sorted((root / "Binary").glob("binary_*_open.json")):
        strategy = path.stem.replace("binary_", "").replace("_open", "")
        if strategy == "general":
            continue
        kept = 0
        per_cell: dict = {}
        cell_cap = max(1, test_machine_cap_per_strategy // 64)
        for r in _drlx_rows(path):
            if r.get("split") != "test":
                continue
            cell = (r.get("lang"), r.get("model"))
            if per_cell.get(cell, 0) >= cell_cap:
                continue
            per_cell[cell] = per_cell.get(cell, 0) + 1
            human = r.get("human_written_text") or ""
            key = f"drlx:{h(human)}"
            adv = not strategy.startswith("general_")
            yield rec(r.get("llm_generated_text") or "", PARAPHRASED_AI if adv else AI_GENERATED, "detectrl_x",
                      language=LANG_NAMES.get(str(r.get("lang", "")).lower(), r.get("lang")),
                      raw_domain=r.get("domain"), generator_raw=r.get("model"), subset=f"test_{strategy}",
                      attack=strategy if adv else "none", is_adversarial=adv, edit_type=strategy,
                      original_split="test", group_key=key, parent_id=key, role="adversarial_only" if adv else "official_test",
                      metadata={"model": r.get("model"), "strategy": strategy})
            kept += 1
        gc.collect()


# ------------------------------------------------------------------ OpAI-Bench

def _json_or_literal(v):
    if v is None or v == "" or (isinstance(v, float) and v != v):
        return None
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        try:
            return ast.literal_eval(v)
        except (ValueError, SyntaxError):
            return None


def opai_bench(root: Path) -> Iterator[dict]:
    for f in sorted(root.rglob("*.csv")):
        cfg = f.parts[-3]  # default | ablations
        split = f.parent.name
        df = pd.read_csv(f, dtype=str, keep_default_na=False)
        for r in df.to_dict("records"):
            ratio = float(r.get("ai_char_ratio") or 0)
            if r.get("version") == "v0" or ratio == 0:
                fine = HUMAN
            elif ratio >= 0.95:
                fine = AI_EDITED
            else:
                fine = MIXED
            spans = _json_or_literal(r.get("ai_spans_char"))
            spans = [[int(s[0]), int(s[1]), "ai"] for s in spans] if isinstance(spans, list) and spans and \
                isinstance(spans[0], (list, tuple)) else (
                [[int(s["start"]), int(s["end"]), "ai"] for s in spans] if isinstance(spans, list) and spans and
                isinstance(spans[0], dict) else ([] if fine == HUMAN else None))
            sents = _json_or_literal(r.get("sentences"))
            slabs = _json_or_literal(r.get("sentence_labels"))
            sentence_labels = [[s, int(l)] for s, l in zip(sents, slabs)] if isinstance(sents, list) and \
                isinstance(slabs, list) and len(sents) == len(slabs) else None
            yield rec(r["text"], fine, "opai_bench", raw_domain=r.get("domain"),
                      generator_raw=r.get("generator") if fine != HUMAN else "human", ai_fraction=ratio,
                      subset=f"{cfg}:{r.get('ablation_type') or 'main'}", source_id=r.get("record_id"),
                      group_key=f"opai:{r.get('document_hash_id') or r.get('id')}",
                      parent_id=f"opai:{r.get('document_hash_id') or r.get('id')}",
                      edit_type=r.get("edit_operation") or None, span_labels=spans, sentence_labels=sentence_labels,
                      original_split=split, role="official_test" if split == "test" else None,
                      metadata={"version": r.get("version"), "version_index": r.get("version_index"),
                                "generator": r.get("generator"), "ai_token_ratio": r.get("ai_token_ratio"),
                                "ai_sentence_ratio": r.get("ai_sentence_ratio"), "doc_id": r.get("id"),
                                "file": f.name})
        del df
        gc.collect()


# ------------------------------------------------------------------ Heterogeneous AI Spans

HET_DOMAIN = {"beigebook": "reports", "jmlr": "academic", "gutenberg": "literary", "standard_ebooks": "literary",
              "standardebooks": "literary", "wikitext": "wiki", "hansard": "speech"}


def het_ai_spans(root: Path) -> Iterator[dict]:
    for cfg in ("mixed", "human_controls"):
        for f in sorted((root / "data" / cfg).glob("*.parquet")):
            df = pd.read_parquet(f)
            for r in df.to_dict("records"):
                text = r["text"]
                spans = [[int(s["start"]), int(s["end"]), "ai" if s["label"] != "human" else "human"]
                         for s in (r.get("spans") if r.get("spans") is not None else [])]
                fine = HUMAN if cfg == "human_controls" else MIXED
                ds_src = str(r.get("source_dataset") or "").lower()
                model = r.get("reported_model") or r.get("requested_model")
                yield rec(text, fine, "het_ai_spans", raw_domain=HET_DOMAIN.get(ds_src, ds_src or None),
                          generator_raw=model if fine != HUMAN else "human",
                          ai_fraction=float(r.get("ai_fraction_chars") or 0.0), subset=f"{cfg}:{r.get('cohort')}",
                          source_id=r.get("source_id"), group_key=f"het:{r.get('group_id')}",
                          parent_id=f"het:{r.get('source_id')}", span_labels=[s for s in spans if s[2] == "ai"],
                          original_split=r.get("split"), role="official_test" if r.get("split") == "test" else None,
                          metadata={"doc_id": r.get("id"), "cohort": r.get("cohort"), "source_dataset": ds_src,
                                    "requested_model": r.get("requested_model"), "offset_unit": r.get("offset_unit"),
                                    "source_license": r.get("source_license")})


# ------------------------------------------------------------------ Academic arXiv / GPT / Gemini

def academic_arxiv_gpt_gemini(root: Path, human_block: int = 25) -> Iterator[dict]:
    df = pd.read_parquet(root / "academic_text.parquet")
    hi = 0
    for i, r in enumerate(df.itertuples(index=False)):
        src = str(r.source)
        if int(r.label) == 0:
            # no paper id is published: consecutive human paragraphs are grouped in blocks so
            # paragraphs of one paper (stored contiguously) stay on one side; near-dup links add more
            yield rec(r.text, HUMAN, "academic_arxiv_gpt_gemini", raw_domain="academic", subset="arxiv",
                      group_key=f"aca:h{hi // human_block}", metadata={"row": i})
            hi += 1
        else:
            yield rec(r.text, AI_GENERATED, "academic_arxiv_gpt_gemini", raw_domain="academic", generator_raw=src,
                      subset=src, group_key=f"aca:a{i}", metadata={"row": i})


# ------------------------------------------------------------------ Nigerian Academic Writing Corpus

def _chunks(text: str, words: int = 350, max_chunks: int = 4) -> list[str]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if len(p.split()) >= 25]
    out, cur = [], []
    for p in paras:
        cur.append(p)
        if sum(len(x.split()) for x in cur) >= words:
            out.append("\n\n".join(cur))
            cur = []
        if len(out) >= max_chunks * 3:
            break
    if cur and sum(len(x.split()) for x in cur) >= 80:
        out.append("\n\n".join(cur))
    if len(out) > max_chunks:  # spread over the document instead of only the opening pages
        step = len(out) / max_chunks
        out = [out[int(k * step)] for k in range(max_chunks)]
    return out


def nigerian_academic(root: Path) -> Iterator[dict]:
    for z in sorted(root.glob("*_texts.zip")):
        uni = z.stem.replace("_texts", "")
        with zipfile.ZipFile(z) as zf:
            for name in zf.namelist():
                if not name.endswith(".txt"):
                    continue
                text = zf.read(name).decode("utf-8", "replace")
                fname = Path(name).name
                for k, chunk in enumerate(_chunks(text)):
                    yield rec(chunk, HUMAN, "nigerian_academic", raw_domain="academic", subset=f"human_{uni}",
                              source_id=f"{fname}#{k}", group_key=f"nig:{fname}", parent_id=f"nig:{fname}",
                              metadata={"university": uni, "chunk": k})
    ai = root / "ai_generated_real.jsonl"
    if ai.exists():
        with open(ai, encoding="utf-8") as fh:
            for line in fh:
                r = json.loads(line)
                src_file = r.get("source_file") or ""
                yield rec(r.get("text") or "", AI_GENERATED, "nigerian_academic", raw_domain="academic",
                          generator_raw=r.get("source"), subset="ai_essays",
                          group_key=f"nig:{Path(src_file).name}" if src_file else f"nig:ai:{h(r.get('text') or '')}",
                          parent_id=f"nig:{Path(src_file).name}" if src_file else None,
                          metadata={"topic": r.get("topic"), "source_file": src_file})


# ------------------------------------------------------------------ AIGTxt

def aigtxt(root: Path) -> Iterator[dict]:
    for f in sorted(root.glob("*.xlsx")):
        sheets = pd.read_excel(f, sheet_name=None, dtype=str)
        for sname, df in sheets.items():
            cols = {c: str(c).lower() for c in df.columns}
            hc = next((c for c, l in cols.items() if "human" in l), None)
            gc_ = next((c for c, l in cols.items() if ("chatgpt" in l or "gpt" in l) and "mix" not in l), None)
            mc = next((c for c, l in cols.items() if "mix" in l), None)
            dc = next((c for c, l in cols.items() if "domain" in l or "area" in l), None)
            for i, r in df.iterrows():
                key = f"aig:{sname}:{i}"
                meta = {"sheet": sname, "area": _s(r.get(dc)) if dc else None}
                for col, fine, gen in ((hc, HUMAN, "human"), (gc_, AI_GENERATED, "chatgpt"), (mc, MIXED, "chatgpt")):
                    if col is None or not isinstance(r.get(col), str):
                        continue
                    yield rec(r[col], fine, "aigtxt", raw_domain="academic", generator_raw=gen,
                              ai_fraction=0.5 if fine == MIXED else None, subset=str(col), group_key=key,
                              parent_id=key, edit_type="mixed_50_50" if fine == MIXED else None,
                              role="eval_only", metadata=meta)


# ------------------------------------------------------------------ EditLens (gated, schema checked at runtime)

def editlens(root: Path) -> Iterator[dict]:
    for f in sorted((root / "data").glob("*.parquet")):
        split = f.stem.split("-")[0]
        df = pd.read_parquet(f)
        cols = {c.lower(): c for c in df.columns}
        tcol = next((cols[c] for c in ("text", "edited_text", "content") if c in cols), None)
        lcol = next((cols[c] for c in ("label", "text_type", "type", "category") if c in cols), None)
        scol = next((cols[c] for c in ("score", "edit_score", "ai_score", "editing_score", "similarity") if c in cols), None)
        gcol = next((cols[c] for c in ("model", "generator", "llm") if c in cols), None)
        if tcol is None or lcol is None:
            raise ValueError(f"EditLens: unexpected columns {list(df.columns)}")
        for r in df.to_dict("records"):
            lab = str(r[lcol]).strip().upper()
            fine = HUMAN if lab.startswith("HUMAN") else AI_GENERATED if lab.startswith("GEN") or lab == "AI" else \
                AI_EDITED if lab.startswith("EDIT") else UNKNOWN
            score = r.get(scol) if scol else None
            text = r[tcol]
            src_key = next((r[c] for c in df.columns if c.lower() in ("source_id", "human_id", "original_id", "id_source")), None)
            yield rec(text, fine, "editlens", generator_raw=_s(r.get(gcol)) if gcol else None,
                      ai_fraction=float(score) if score is not None and fine == AI_EDITED and _s(score) else None,
                      subset=split, original_split=split, group_key=f"edl:{src_key or h(text)}",
                      role="official_test" if split.startswith("test") else None,
                      edit_type="ai_edit" if fine == AI_EDITED else None,
                      metadata={k: _s(v) for k, v in r.items() if k != tcol and isinstance(v, (str, int, float))})


# ------------------------------------------------------------------ GRADTEX

GRADTEX_EDITED = ("polish", "paraphrase", "rewrite_style")


def gradtex(root: Path) -> Iterator[dict]:
    for split in ("train", "validation", "test"):
        f = root / f"{split}.parquet"
        if not f.exists():
            continue
        df = pd.read_parquet(f)
        for r in df.to_dict("records"):
            cls = str(r.get("multiclass_label"))
            scen = str(r.get("scenario") or "")
            if cls == "HWT":
                fine = HUMAN
            elif cls == "MGT":
                fine = AI_GENERATED
            elif scen.startswith("complete"):
                fine = MIXED
            elif scen.startswith(GRADTEX_EDITED):
                fine = AI_EDITED
            else:
                fine = MIXED
            src = r.get("human_source_text") or r["text"]
            yield rec(r["text"], fine, "gradtex", raw_domain=r.get("domain"),
                      generator_raw=r.get("generator_model") if fine != HUMAN else "human",
                      ai_fraction=(1 / 3) if scen.startswith("complete") else None, subset=scen,
                      group_key=f"grad:{h(src)}", parent_id=f"grad:{h(src)}", edit_type=scen if fine != HUMAN else None,
                      original_split=split, role="official_test" if split == "test" else None,
                      metadata={"multiclass_label": cls, "scenario_family": r.get("scenario_family"),
                                "sub_source": r.get("sub_source"), "test_split": _s(r.get("test_split")),
                                "evaluation_setup": _s(r.get("evaluation_setup")),
                                "original_name_in_MAGE": _s(r.get("original_name_in_MAGE"))})


# ------------------------------------------------------------------ TXD-22

def _txd_fine(src: str) -> tuple[str, str | None]:
    s = re.sub(r"[^a-z ]+", " ", src.lower())
    s = " ".join(s.split())
    if s in ("human written", "human"):
        return HUMAN, None
    has_h = "human" in s
    refined = "refined" in s
    generated = "generated" in s
    if generated and refined and has_h:
        return MIXED, "ai_generated+ai_refined+human_written"
    if generated and has_h:
        return MIXED, "ai_generated+human_written"
    if has_h and refined:
        return AI_EDITED, "human_written+ai_refined"
    if generated and refined:
        return PARAPHRASED_AI, "ai_generated+ai_refined"
    return AI_GENERATED, None


def txd22(root: Path) -> Iterator[dict]:
    f = next(root.glob("*.csv"))
    df = pd.read_csv(f, dtype=str, keep_default_na=False, encoding="cp1252", encoding_errors="replace")
    for r in df.to_dict("records"):
        fine, edit = _txd_fine(r["Source"])
        q = r["Question"]
        yield rec(r["Answer"], fine, "txd22", raw_domain="qa_professional",
                  generator_raw=None if fine in (MIXED, AI_EDITED, PARAPHRASED_AI) or fine == HUMAN else r["Source"],
                  subset=r["Source"], group_key=f"txd:{h(q)}", parent_id=f"txd:{h(q)}", edit_type=edit,
                  metadata={"source_class": r["Source"], "question": q[:300]})


# ------------------------------------------------------------------ Beemo

def beemo(root: Path) -> Iterator[dict]:
    df = pd.read_parquet(next((root / "data").glob("*.parquet")))
    for r in df.to_dict("records"):
        key = f"beemo:{r['prompt_id']}"
        meta = {"category": r.get("category"), "model": r.get("model"), "id": int(r["id"])}
        common = dict(raw_domain=str(r.get("category") or "").lower().replace(" ", "_"), group_key=key, parent_id=key)
        yield rec(r["human_output"], HUMAN, "beemo", subset="human_output", metadata=meta, **common)
        yield rec(r["model_output"], AI_GENERATED, "beemo", generator_raw=r.get("model"), subset="model_output",
                  metadata=meta, **common)
        if r.get("human_edits"):
            yield rec(r["human_edits"], HUMAN_EDITED_AI, "beemo", generator_raw=r.get("model"), subset="human_edits",
                      ai_fraction=None, edit_type="expert_edit", metadata=meta, **common)
        for editor in ("llama-3.1-70b", "gpt-4o"):
            edits = _json_or_literal(r.get(f"{editor}_edits")) or []
            for e in edits:
                for prompt, text in (e.items() if isinstance(e, dict) else []):
                    yield rec(text, PARAPHRASED_AI, "beemo", generator_raw=editor, subset=f"{editor}_{prompt}",
                              edit_type=f"llm_edit_{prompt}", metadata={**meta, "editor": editor}, **common)


# ------------------------------------------------------------------ MDTA

def mdta(root: Path) -> Iterator[dict]:
    for f in sorted(root.glob("*.jsonl")):
        dom = f.stem
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                r = json.loads(line)
                key = f"mdta:{dom}:{r['question_index']}"
                common = dict(raw_domain=dom, group_key=key, parent_id=key)
                for k, ans in enumerate(r.get("human_answers") or []):
                    yield rec(ans, HUMAN, "mdta", subset="human", metadata={"answer": k}, **common)
                for model, temps in (r.get("model_responses") or {}).items():
                    for temp, text in (temps or {}).items():
                        if text:
                            yield rec(text, AI_GENERATED, "mdta", generator_raw=model, subset=f"{model}:{temp}",
                                      metadata={"temperature": temp}, **common)
                for model, adv in (r.get("adv_responses") or {}).items():
                    for variant in ("adv_plain", "adv_no_letter_x", "adv_no_letters_xy"):
                        text = (adv or {}).get(variant)
                        if text:
                            yield rec(text, PARAPHRASED_AI, "mdta", generator_raw=model, subset=f"{model}:{variant}",
                                      attack=variant, is_adversarial=True, edit_type=variant,
                                      role="adversarial_only" if variant == "adv_no_letters_xy" else None,
                                      metadata={"letters": adv.get("adv_letters_xy") if variant.endswith("xy")
                                                else adv.get("adv_letter_x")}, **common)


# ------------------------------------------------------------------ OUTFOX

class _SafeUnpickler(pickle.Unpickler):
    """Only plain containers/strings: refuses every global (no code execution)."""

    def find_class(self, module, name):
        raise pickle.UnpicklingError(f"blocked global {module}.{name}")


def _load_pkl(path: Path):
    with open(path, "rb") as fh:
        return _SafeUnpickler(fh).load()


def outfox(root: Path) -> Iterator[dict]:
    base = next(root.glob("OUTFOX-*"), root) / "data"
    for split in ("train", "valid", "test"):
        humans = _load_pkl(base / "common" / split / f"{split}_humans.pkl")
        for i, text in enumerate(humans):
            key = f"outfox:{split}:{i}"
            yield rec(text, HUMAN, "outfox", raw_domain="essay", subset="human", group_key=key, parent_id=key,
                      original_split=split, role="official_test" if split == "test" else None)
        for model in ("chatgpt", "text_davinci_003", "flan_t5_xxl"):
            p = base / model / split / f"{split}_lms.pkl"
            if not p.exists():
                continue
            for i, text in enumerate(_load_pkl(p)):
                key = f"outfox:{split}:{i}"
                yield rec(text, AI_GENERATED, "outfox", raw_domain="essay", generator_raw=model, subset=model,
                          group_key=key, parent_id=key, original_split=split,
                          role="official_test" if split == "test" else None)
    for model, p in [("chatgpt", base / "chatgpt" / "test" / "test_outfox_attacks.pkl")] + \
            [(m, base / "dipper" / m / "test_attacks.pkl") for m in ("chatgpt", "text_davinci_003", "flan_t5_xxl")]:
        if not p.exists():
            continue
        attack = "outfox_attack" if "outfox" in p.name else "dipper"
        for i, text in enumerate(_load_pkl(p)):
            key = f"outfox:test:{i}"
            yield rec(text, PARAPHRASED_AI, "outfox", raw_domain="essay", generator_raw=model, subset=f"{attack}:{model}",
                      attack=attack, is_adversarial=True, edit_type=attack, group_key=key, parent_id=key,
                      original_split="test", role="adversarial_only")


# ------------------------------------------------------------------ COLING 2025 / OpenLLMText / SeqXGPT

def coling2025_mgt_en(root: Path) -> Iterator[dict]:
    for f in sorted((root / "data").glob("*.parquet")):
        split = f.stem.split("-")[0]
        df = pd.read_parquet(f)
        for r in df.itertuples(index=False):
            fine = HUMAN if int(r.label) == 0 else AI_GENERATED
            yield rec(r.text, fine, "coling2025_mgt_en", language=r.lang or "en", raw_domain=r.sub_source,
                      generator_raw=r.model if fine != HUMAN else "human", subset=f"{r.source}:{r.sub_source}",
                      source_id=r.id, original_split=split, metadata={"source": r.source})
        del df
        gc.collect()


def _itcrow(root: Path, name: str, group_by_id: bool) -> Iterator[dict]:
    for f in sorted((root / "data").glob("*.parquet")):
        df = pd.read_parquet(f)
        for r in df.itertuples(index=False):
            fine = HUMAN if str(r.label).lower() == "human" else AI_GENERATED
            lang = str(r.lang or "en").split("-")[0].lower()
            yield rec(r.text, fine, name, language=lang, raw_domain="web" if name == "openllmtext" else None,
                      generator_raw=r.agent if fine != HUMAN else "human", subset=str(r.source).replace("\\", "/"),
                      source_id=r.id, group_key=f"{name}:{r.id}" if group_by_id else None,
                      metadata={"type": r.type, "date": r.date})
        del df
        gc.collect()


def openllmtext(root: Path) -> Iterator[dict]:
    return _itcrow(root, "openllmtext", group_by_id=True)  # the same web document across agents shares the id


def seqxgpt(root: Path) -> Iterator[dict]:
    return _itcrow(root, "seqxgpt", group_by_id=False)


# ------------------------------------------------------------------ EXTERNAL_HOLDOUT_2026 (evaluation only)

def ai_text_detection_benchmark_2026(root: Path) -> Iterator[dict]:
    for f in sorted((root / "data").glob("*.jsonl")):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                r = json.loads(line)
                fine = HUMAN if r.get("label") == "human" else AI_GENERATED
                genre = r.get("genre") or ("literature" if "literature" in f.name else
                                           "biomedical" if "pmc" in f.name else "encyclopedic")
                yield rec(r["text"], fine, "ai_text_detection_benchmark_2026", raw_domain=genre,
                          generator_raw=r.get("source") if fine != HUMAN else "human", subset=f.stem,
                          source_id=r.get("id"), role="eval_only",
                          metadata={"file": f.name, "negative_control": "literature" in f.name})


ADAPTERS_V2 = {
    "mgtbench2_academic": mgtbench2_academic,
    "mgtpd": mgtpd,
    "detectrl_x": detectrl_x,
    "opai_bench": opai_bench,
    "het_ai_spans": het_ai_spans,
    "academic_arxiv_gpt_gemini": academic_arxiv_gpt_gemini,
    "nigerian_academic": nigerian_academic,
    "aigtxt": aigtxt,
    "editlens": editlens,
    "gradtex": gradtex,
    "txd22": txd22,
    "beemo": beemo,
    "mdta": mdta,
    "outfox": outfox,
    "coling2025_mgt_en": coling2025_mgt_en,
    "openllmtext": openllmtext,
    "seqxgpt": seqxgpt,
    "ai_text_detection_benchmark_2026": ai_text_detection_benchmark_2026,
}
EVAL_ONLY_DATASETS = {"ai_text_detection_benchmark_2026"}
DATASET_HOLDOUT = {"aigtxt"}  # whole new dataset kept out of training (new-dataset / mixed-academic holdout)


# ------------------------------------------------------------------ generator families (V2)

FAMILY_RULES = [
    (r"claude|opus|sonnet|haiku", "claude"),
    (r"gemini|palm|bard", "gemini"),
    (r"gemma", "gemma"),
    (r"deepseek", "deepseek"),
    (r"qwen", "qwen"),
    (r"grok", "grok"),
    (r"moonshot|kimi", "moonshot"),
    (r"mixtral|mistral|ministral", "mistral"),
    (r"llama|vicuna|alpaca|tulu|zephyr|^7b$|^13b$|^30b$|^65b$", "llama"),
    (r"cohere|command", "cohere"),
    (r"gpt-?2|gpt_neo|gpt-neo|gpt-j|gptj|neox", "gpt-oss-older"),
    (r"gpt|chatgpt|davinci|curie|babbage|^ada$|openai|o1|o3|copilot|turbo", "gpt"),
    (r"bloom", "bloom"),
    (r"flan|t5|t0", "t5"),
    (r"opt", "opt"),
    (r"glm|z\.ai", "glm"),
    (r"phi", "phi"),
]


def generator_family(raw) -> tuple[str, str]:
    if raw is None:
        return "unknown", "unknown"
    key = str(raw).strip().lower()
    if key in ("", "human", "none", "no-model"):
        return "human", "human"
    for pattern, fam in FAMILY_RULES:
        if re.search(pattern, key):
            return key, fam
    return key, key


V2_DOMAIN_EXTRA = {"abstracts": "academic", "essays": "academic", "essay": "academic", "science": "academic",
                   "reports": "reports", "fiction": "literary", "news": "news", "academic": "academic",
                   "web": "web", "speech": "speech", "qa_professional": "qa", "open qa": "qa", "closed qa": "qa",
                   "open_qa": "qa", "closed_qa": "qa", "generation": "creative", "rewrite": "creative",
                   "summarize": "summary", "encyclopedic": "wiki", "biomedical": "academic", "literature": "literary"}


def v2_domain(raw) -> str:
    from .textnorm import canonical_domain

    if raw is None:
        return "unknown"
    key = str(raw).strip().lower()
    return V2_DOMAIN_EXTRA.get(key) or canonical_domain(key)
