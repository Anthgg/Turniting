"""Dataset adapters: raw files -> records in the master schema (before validation/dedup).

Each adapter yields dicts with:
  text, label (0/1, or None for MIXED), language, language_source, domain, raw_domain,
  generator, generator_family, dataset, subset, source_id, group_key, attack,
  is_adversarial, is_mixed, original_split, role, metadata (dict)

`group_key` is dataset-scoped and identifies the human source / prompt / question that
derived texts share; build_dataset unions it with exact and near duplicate links.
`role` marks official evaluation roles (e.g. "official_test", "ood", "ood_paraphrase").
"""

from __future__ import annotations

import ast
import csv
import io
import json
import re
import zipfile
from collections.abc import Iterator
from pathlib import Path

import pandas as pd

from .common import HUMAN, MACHINE, RAW_DIR, sha256_text
from .textnorm import canonical_domain, canonical_generator, normalize_label

csv.field_size_limit(2**31 - 1)


def _rec(**kw) -> dict:
    gen = kw.pop("generator_raw", None)
    label = kw.get("label")
    if label == HUMAN:
        generator, family = "human", "human"
    elif gen is None:
        generator, family = "unknown", "unknown"
    else:
        generator, family = canonical_generator(gen)
    raw_domain = kw.get("raw_domain")
    base = {
        "language": None,
        "language_source": "dataset",
        "domain": canonical_domain(raw_domain),
        "generator": generator,
        "generator_family": family,
        "source_id": None,
        "attack": "none",
        "is_adversarial": False,
        "is_mixed": False,
        "original_split": None,
        "role": None,
        "metadata": {},
    }
    base.update(kw)
    return base


# --------------------------------------------------------------------- Iber / AuTex

# Letter -> model. AuTex 2023: card attribution table order. IberAuTex 2024: inferred by
# matching per-(domain, language) counts against the official statistics table on the card
# (A,B,C,E unambiguous; D/F both GPT family, best assignment D=gpt-3.5, F=gpt-4).
AUTEX_MODELS = {"A": "bloom-1b7", "B": "bloom-3b", "C": "bloom-7b1", "D": "babbage",
                "E": "curie", "F": "text-davinci-003"}
IBER_MODELS = {"A": "llama-2-70b-chat", "B": "cohere.command-text-v14", "C": "ai21.j2-ultra-v1",
               "D": "gpt-3.5-turbo-instruct", "E": "mixtral-8x7b-instruct", "F": "gpt-4"}


def _read_tsv(path: Path, quoting=csv.QUOTE_MINIMAL) -> pd.DataFrame:
    return pd.read_csv(path, sep="\t", quoting=quoting, dtype=str, keep_default_na=False)


def _unescape(text: str) -> str:
    # IberAuTex TSVs store newlines as literal "\n"
    return text.replace("\\n", "\n").replace("\\t", "\t")


def iberautextification() -> Iterator[dict]:
    root = RAW_DIR / "iberautextification" / "data" / "subtask_1"
    for split in ("train", "test"):
        df = _read_tsv(root / f"{split}.tsv", quoting=csv.QUOTE_NONE)
        for row in df.itertuples(index=False):
            label = normalize_label(row.label)
            prompt = _unescape(row.prompt)
            yield _rec(
                text=_unescape(row.text),
                label=label,
                language=row.language,
                raw_domain=row.domain,
                generator_raw=IBER_MODELS.get(row.model) if label == MACHINE else None,
                dataset="iberautextification",
                subset=f"subtask_1/{split}",
                source_id=f"iber:{row.id}",
                # machine texts share a prompt built from a human source (title/context)
                group_key=f"iber:prompt:{sha256_text(prompt)[:16]}" if prompt != "NO-PROMPT" else f"iber:id:{row.id}",
                original_split=split,
                role="official_test" if split == "test" else None,
                metadata={"orig_id": row.id, "model_letter": row.model,
                          "model_mapping": "inferred_from_card_statistics"},
            )


def autextification2023() -> Iterator[dict]:
    root = RAW_DIR / "autextification2023" / "data"
    for split in ("train", "test"):
        for lang in ("es", "en"):
            df = _read_tsv(root / split / "subtask_1" / lang / f"{split}.tsv")
            for row in df.itertuples(index=False):
                label = normalize_label(row.label)
                model = getattr(row, "model", "NO-MODEL")
                yield _rec(
                    text=row.text,
                    label=label,
                    language=lang,
                    raw_domain=row.domain,
                    generator_raw=AUTEX_MODELS.get(model) if label == MACHINE else None,
                    dataset="autextification2023",
                    subset=f"subtask_1/{lang}/{split}",
                    source_id=f"autex:{lang}:{row.id}",
                    group_key=(f"autex:prompt:{sha256_text(row.prompt)[:16]}"
                               if row.prompt != "NO-PROMPT" else f"autex:{lang}:{split}:{row.id}"),
                    original_split=split,
                    role="official_test" if split == "test" else None,
                    metadata={"orig_id": row.id, "model_letter": model,
                              "model_mapping": "card_table_order"},
                )


# --------------------------------------------------------------------- SemEval 2024 T8

SEMEVAL_LANG = {"russian": "ru", "arabic": "ar", "german": "de", "bulgarian": "bg",
                "urdu": "ur", "indonesian": "id", "chinese": "zh", "italian": "it"}


def _jsonl_from_zip(zf: zipfile.ZipFile, name: str) -> Iterator[dict]:
    with zf.open(name) as handle:
        for line in io.TextIOWrapper(handle, encoding="utf-8"):
            if line.strip():
                yield json.loads(line)


def semeval2024_task8() -> Iterator[dict]:
    zf = zipfile.ZipFile(RAW_DIR / "semeval2024_task8" / "SemEval2024-Task8-data.zip")
    base = "SemEval2024-Task8/"
    # Subtask A: main HUMAN vs MACHINE (label 1 = machine, verified against model=='human')
    for track in ("monolingual", "multilingual"):
        for split in ("train", "dev", "test"):
            for row in _jsonl_from_zip(zf, f"{base}SubtaskA/subtaskA_{split}_{track}.jsonl"):
                label = normalize_label(row["label"])
                source = row.get("source")
                lang = "en" if track == "monolingual" else SEMEVAL_LANG.get(source or "", None)
                yield _rec(
                    text=row["text"],
                    label=label,
                    language=lang,
                    language_source="dataset" if lang else None,
                    raw_domain=source if track == "monolingual" else
                    {"russian": "news", "arabic": "wikipedia", "german": "wikipedia",
                     "bulgarian": "news", "urdu": "news", "indonesian": "news",
                     "chinese": "qa"}.get(source or "", source),
                    generator_raw=row.get("model") if label == MACHINE else None,
                    dataset="semeval2024_task8",
                    subset=f"A/{track}/{split}",
                    source_id=f"semA:{track}:{split}:{row['id']}",
                    group_key=f"semA:{track}:{split}:{row['id']}",
                    original_split=split,
                    # Official test was built with new generators/domains -> OOD role
                    role="ood" if split == "test" else None,
                    metadata={"orig_id": row["id"], "source": source, "track": track},
                )
    # Subtask B: generator attribution. Used as auxiliary generator metadata; texts mostly
    # overlap Subtask A and collapse in exact dedup.
    for split in ("train", "dev", "test"):
        for row in _jsonl_from_zip(zf, f"{base}SubtaskB/subtaskB_{split}.jsonl"):
            model = row.get("model")
            if model is None:
                continue  # test file without model names
            label = HUMAN if model == "human" else MACHINE
            yield _rec(
                text=row["text"], label=label, language="en", raw_domain=row.get("source"),
                generator_raw=model if label == MACHINE else None,
                dataset="semeval2024_task8", subset=f"B/{split}",
                source_id=f"semB:{split}:{row['id']}", group_key=f"semB:{split}:{row['id']}",
                original_split=split, role="aux_generator_metadata",
                metadata={"orig_id": row["id"], "source": row.get("source"), "b_label": row["label"]},
            )
    # Subtask C: human-then-machine texts with boundary word index. Never binarized.
    for split in ("train", "dev", "test"):
        for row in _jsonl_from_zip(zf, f"{base}SubtaskC/subtaskC_{split}.jsonl"):
            yield _rec(
                text=row["text"], label=None, language="en", raw_domain="academic",
                dataset="semeval2024_task8", subset=f"C/{split}",
                source_id=f"semC:{split}:{row['id']}", group_key=f"semC:{split}:{row['id']}",
                is_mixed=True, original_split=split, role="mixed",
                metadata={"orig_id": row["id"], "boundary_word_index": row.get("label")},
            )


# --------------------------------------------------------------------- M4

M4_LANG = {"arabic": "ar", "bulgarian": "bg", "germanwikipedia": "de", "id-newspaper": "id",
           "qazh": "zh", "russian": "ru", "urdu": "ur"}
M4_DOMAIN = {"arabic": "wikipedia", "bulgarian": "news", "germanwikipedia": "wikipedia",
             "id-newspaper": "news", "qazh": "qa", "russian": "news", "urdu": "news"}


def _maybe_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str) and value.startswith("[") and value.endswith("]"):
        try:
            parsed = ast.literal_eval(value)
            if isinstance(parsed, list):
                return [str(v) for v in parsed]
        except (ValueError, SyntaxError):
            pass
    return [value] if isinstance(value, str) else []


def m4() -> Iterator[dict]:
    root = RAW_DIR / "m4"
    for path in sorted(root.glob("*.jsonl")):
        stem = path.stem
        prefix = stem.split("_")[0]
        if stem.startswith("bulgarian"):
            prefix = "bulgarian"
        lang = M4_LANG.get(prefix, "en")
        raw_domain = M4_DOMAIN.get(prefix, prefix)
        with open(path, encoding="utf-8") as handle:
            for line_no, line in enumerate(handle):
                if not line.strip():
                    continue
                row = json.loads(line)
                model = row.get("model")
                prompt = row.get("prompt") or row.get("promt") or ""
                human = next((row[k] for k in ("human_text", "abstract", "text", "human_reviews") if row.get(k)), None)
                if "bloomz" in stem:
                    # bloomz files store the prompt in machine_text; the generation lives here
                    machine = next((row[k] for k in ("machine_abstract", "machine_answer", "bloom_reviews") if row.get(k)), None)
                else:
                    machine = row.get("machine_text")
                sid = next((str(row[k]) for k in ("source_ID", "source_id", "q_id", "question_id", "id")
                            if row.get(k) not in (None, "", "None")), None)
                group = f"m4:{prefix}:{sid}" if sid else f"m4:{prefix}:h:{sha256_text(str(human))[:16]}"
                common = dict(language=lang, raw_domain=raw_domain, dataset="m4", subset=stem,
                              group_key=group, metadata={"file": stem, "line": line_no, "source_id": sid})
                for i, text in enumerate(_maybe_list(human)):
                    yield _rec(text=text, label=HUMAN, source_id=f"m4:{stem}:{line_no}:h{i}", **common)
                for i, text in enumerate(_maybe_list(machine)):
                    # drop echoed prompts (e.g. peerread_llama repeats the instruction first)
                    if prompt and text.strip().startswith(_maybe_list(prompt)[0].strip()[:60]):
                        text = text.strip()[len(_maybe_list(prompt)[0].strip()):]
                    yield _rec(text=text, label=MACHINE, generator_raw=model,
                               source_id=f"m4:{stem}:{line_no}:m{i}", **common)


# --------------------------------------------------------------------- MAGE

MAGE_DOMAIN_PREFIX = re.compile(r"^([a-z_]+?)_(human|machine)")


def mage() -> Iterator[dict]:
    root = RAW_DIR / "mage"
    files = {"train.csv": ("train", None), "valid.csv": ("validation", None),
             "test.csv": ("test", "official_test"), "test_ood_set_gpt.csv": ("test_ood_gpt", "ood"),
             "test_ood_set_gpt_para.csv": ("test_ood_gpt_para", "ood_paraphrase")}
    for name, (split, role) in files.items():
        for chunk in pd.read_csv(root / name, dtype={"text": str, "src": str}, chunksize=50_000,
                                 keep_default_na=False):
            for row in chunk.itertuples(index=False):
                # Official MAGE semantics: 0 = machine-generated, 1 = human-written.
                label = normalize_label(int(row.label), scheme="human1")
                src = row.src
                m = MAGE_DOMAIN_PREFIX.match(src)
                raw_domain = m.group(1) if m else src.split("_")[0]
                generator = None
                attack = "none"
                if "_machine_" in src:
                    generator = src.split("_machine_", 1)[1].split("_", 1)[1] if src.count("_") >= 3 else src
                if split == "test_ood_gpt_para":
                    raw_domain = src.split("_")[0]
                    generator = "gpt-4" if label == MACHINE else None
                    attack = "paraphrase"
                elif split == "test_ood_gpt":
                    raw_domain = src.split("_")[0]
                    generator = "gpt-4" if label == MACHINE else None
                yield _rec(
                    text=row.text, label=label, language="en", raw_domain=raw_domain,
                    generator_raw=generator, dataset="mage", subset=split,
                    group_key=f"mage:{split}:{sha256_text(row.text)[:16]}",
                    attack=attack, is_adversarial=attack != "none",
                    original_split=split, role=role,
                    metadata={"src": src, "orig_label": int(row.label)},
                )


# --------------------------------------------------------------------- HC3

def hc3() -> Iterator[dict]:
    for name, lang in (("hc3", "en"), ("hc3_chinese", "zh")):
        with open(RAW_DIR / name / "all.jsonl", encoding="utf-8") as handle:
            for q_no, line in enumerate(handle):
                row = json.loads(line)
                question = row.get("question", "")
                raw_domain = row.get("source") or "qa"
                group = f"hc3:{lang}:q:{sha256_text(question)[:16]}"
                for kind, label in (("human_answers", HUMAN), ("chatgpt_answers", MACHINE)):
                    for i, answer in enumerate(row.get(kind) or []):
                        yield _rec(
                            text=answer, label=label, language=lang, raw_domain=raw_domain,
                            generator_raw="chatgpt" if label == MACHINE else None,
                            dataset="hc3" if lang == "en" else "hc3_chinese", subset=raw_domain,
                            source_id=f"hc3:{lang}:{q_no}:{kind[:1]}{i}", group_key=group,
                            metadata={"question_index": q_no, "question_sha": sha256_text(question)[:16]},
                        )


# --------------------------------------------------------------------- TuringBench

def turingbench() -> Iterator[dict]:
    zf = zipfile.ZipFile(RAW_DIR / "turingbench" / "TuringBench.zip")
    names = sorted(n for n in zf.namelist() if re.match(r"TuringBench/TT_[^/]+/(train|valid|test)\.csv$", n))
    for name in names:
        folder, split = name.split("/")[1], name.split("/")[2][:-4]
        with zf.open(name) as handle:
            df = pd.read_csv(handle, dtype=str, keep_default_na=False)
        for row in df.itertuples(index=False):
            label = HUMAN if row.label.strip().lower() == "human" else MACHINE
            yield _rec(
                text=row.Generation, label=label, language="en", raw_domain="news",
                generator_raw=row.label if label == MACHINE else None,
                dataset="turingbench", subset=f"{folder}/{split}",
                group_key=f"turing:{sha256_text(row.Generation)[:16]}",
                original_split={"valid": "validation"}.get(split, split),
                metadata={"folder": folder, "orig_label": row.label},
            )


# --------------------------------------------------------------------- Ghostbuster

GHOSTBUSTER_GEN = {"gpt": "gpt-3.5-turbo", "gpt_prompt1": "gpt-3.5-turbo", "gpt_prompt2": "gpt-3.5-turbo",
                   "gpt_semantic": "gpt-3.5-turbo", "gpt_writing": "gpt-3.5-turbo", "claude": "claude"}


def ghostbuster_essay() -> Iterator[dict]:
    root = RAW_DIR / "ghostbuster_essay" / "repo" / "essay"
    for folder in sorted(p for p in root.iterdir() if p.is_dir() and p.name != "prompts"):
        for path in sorted(folder.glob("*.txt"), key=lambda p: p.stem):
            label = HUMAN if folder.name == "human" else MACHINE
            yield _rec(
                text=path.read_text(encoding="utf-8", errors="replace"), label=label, language="en",
                raw_domain="essay", generator_raw=GHOSTBUSTER_GEN.get(folder.name),
                dataset="ghostbuster_essay", subset=folder.name,
                source_id=f"ghost:{folder.name}:{path.stem}", group_key=f"ghost:essay:{path.stem}",
                metadata={"variant": folder.name, "essay_id": path.stem},
            )


# --------------------------------------------------------------------- RAID (streaming)

RAID_COLS = ["id", "adv_source_id", "source_id", "model", "decoding", "repetition_penalty",
             "attack", "domain", "generation"]


def raid_stratum(model, domain, attack, decoding, rep) -> str:
    return f"{model}|{domain}|{attack}|{decoding}|{rep}"


def raid_rows(path: Path, chunksize: int = 50_000, columns=RAID_COLS) -> Iterator[pd.DataFrame]:
    for chunk in pd.read_csv(path, usecols=columns, dtype=str, keep_default_na=False,
                             chunksize=chunksize, engine="c"):
        yield chunk


def raid(selected_ids: set[str] | None = None, path: Path | None = None) -> Iterator[dict]:
    """Yield RAID rows; when `selected_ids` is given, only those (stratified sample)."""
    path = path or RAW_DIR / "raid" / "train.csv"
    for chunk in raid_rows(path):
        if selected_ids is not None:
            chunk = chunk[chunk["id"].isin(selected_ids)]
        for row in chunk.itertuples(index=False):
            label = HUMAN if row.model == "human" else MACHINE
            attack = row.attack or "none"
            group = row.source_id or row.adv_source_id or row.id
            yield _rec(
                text=row.generation, label=label, language="en", raw_domain=row.domain,
                generator_raw=row.model if label == MACHINE else None,
                dataset="raid", subset=f"{row.domain}/{attack}",
                source_id=row.id, group_key=f"raid:{group}",
                attack=attack, is_adversarial=attack != "none", original_split="train",
                metadata={"decoding": row.decoding, "repetition_penalty": row.repetition_penalty,
                          "adv_source_id": row.adv_source_id, "raid_source_id": row.source_id,
                          "stratum": raid_stratum(row.model, row.domain, attack, row.decoding,
                                                  row.repetition_penalty)},
            )


ADAPTERS = {
    "iberautextification": iberautextification,
    "autextification2023": autextification2023,
    "semeval2024_task8": semeval2024_task8,
    "m4": m4,
    "mage": mage,
    "hc3": hc3,
    "turingbench": turingbench,
    "ghostbuster_essay": ghostbuster_essay,
    "raid": raid,
}
