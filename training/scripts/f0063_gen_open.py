"""F006.3: multilingual AI text from OPEN generators, run on the Colab GPU (no API key, no usage limits).

    python scripts/f0063_gen_open.py --gen qwen2.5-14b        # one generator at a time; resumable (custom_id)
    python scripts/f0063_gen_open.py --all

Generator roles (f0063_common.OPEN_GENERATORS, fixed before training): TRAIN (Qwen2.5-14B, Mistral-Nemo-12B), VAL_UNSEEN_PROXY
(OLMo-2-7B), FINAL_ONLY (Phi-3.5-mini, Granite-3.1-8B). TRAIN generators only use TRAIN / VAL / CAL topics and human parents;
FINAL_ONLY generators only FINAL topics and FINAL-side human parents, so their rows can never meet TRAIN.
Per row: provider, model, model_version (HF revision), generation_date, language, prompt_family, domain, temperature, generation_type.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0063_common import (FINE, LANG_NAME, LANG_WEIGHT, LANGS, MULTI, NORM, OPEN_GENERATORS, SEED, norm_text, sha256_text,  # noqa: E402
                          stable_id, topic_side, venue_side, write_json)

COUNTS = {"TRAIN": {"AI_GENERATED": 2600, "AI_REVISED": 500, "HUMAN_REVISED_BY_AI": 500, "HUMAN_WITH_AI_INSERTS": 350, "AI_WITH_HUMAN_INSERTS": 350},
          "VAL_UNSEEN_PROXY": {"AI_GENERATED": 700, "HUMAN_REVISED_BY_AI": 150},
          "FINAL_ONLY": {"AI_GENERATED": 700, "HUMAN_REVISED_BY_AI": 150, "HUMAN_WITH_AI_INSERTS": 100, "AI_WITH_HUMAN_INSERTS": 100}}
SECTIONS = ["abstract", "introduction", "theoretical framework", "methodology", "results", "discussion", "conclusion", "executive summary"]
LENGTHS = [(120, 220), (220, 350), (350, 480)]
STYLE = {"tone": ["neutral expository", "argumentative", "critical", "cautious and hedged", "plain but rigorous"],
         "person": ["impersonal", "first person plural", "first person singular", "third person"],
         "density": ["low", "medium", "high"],
         "citations": ["no citations", "one fictitious citation (Surname, year)", "two or three fictitious citations (Surname, year)"]}
TEMPS = [0.6, 0.8, 1.0]
PREAMBLE = re.compile(r"^(here is|here's|sure|certainly|claro|aquí|voici|hier ist|segue|aqui está|of course)[^\n]*\n+", re.I)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def lang_pick(rng: random.Random) -> str:
    return rng.choices(LANGS, weights=[LANG_WEIGHT[k] for k in LANGS])[0]


def topics(role: str) -> list[tuple[str, str]]:
    oa = pd.read_parquet(NORM / "openalex_academic.parquet", columns=["field", "topic"]).drop_duplicates()
    want = {"TRAIN": {"TRAIN", "VAL", "CAL"}, "VAL_UNSEEN_PROXY": {"VAL"}, "FINAL_ONLY": {"FINAL"}}[role]
    t = [(f, tp) for f, tp in oa.itertuples(index=False) if topic_side(tp) in want]
    return sorted(set(t))


def humans(role: str) -> pd.DataFrame:
    oa = pd.read_parquet(NORM / "openalex_academic.parquet")
    oa = oa[oa["language"].isin(LANGS)]
    want = {"TRAIN": {"TRAIN", "VAL", "CAL"}, "VAL_UNSEEN_PROXY": {"VAL"}, "FINAL_ONLY": {"FINAL"}}[role]
    return oa[oa["venue"].map(venue_side).isin(want)].reset_index(drop=True)


def gen_prompt(rng, lang, field, topic) -> tuple[str, dict]:
    sec = rng.choice(SECTIONS)
    lo, hi = rng.choice(LENGTHS)
    k = {n: rng.choice(v) for n, v in STYLE.items()}
    p = (f"Write an original {sec} section of an academic work in the field of {field}, on the topic \"{topic}\". Write it entirely in "
         f"{LANG_NAME[lang]}, {lo}-{hi} words. Tone: {k['tone']}. Grammatical person: {k['person']}. Technical density: {k['density']}. "
         f"Citations: {k['citations']} (invented authors only). Output only the text, without title, headings, lists of references or comments.")
    return p, {"section": sec, "len": f"{lo}-{hi}", "style": k}


def plan(name: str) -> list[dict]:
    g = OPEN_GENERATORS[name]
    role = g["role"]
    rng = random.Random(f"{SEED}:{name}")
    tps = topics(role)
    hp = humans(role)
    order = list(range(len(hp)))
    rng.shuffle(order)
    hit = iter(order)
    reqs = []
    c = COUNTS[role]
    for i in range(c.get("AI_GENERATED", 0)):
        lang = lang_pick(rng)
        field, topic = rng.choice(tps)
        p, meta = gen_prompt(rng, lang, field, topic)
        side = "FINAL" if role == "FINAL_ONLY" else "VAL" if role == "VAL_UNSEEN_PROXY" else topic_side(topic)
        reqs.append({"custom_id": f"{name}:gen:{i:05d}", "cls": "AI_GENERATED", "lang": lang, "prompt": p, "meta": {**meta, "field": field, "topic": topic},
                     "temperature": rng.choice(TEMPS), "parent_id": f"{name}:topic:{i:05d}", "group_id": f"gen:{topic}", "side": side})
    for cls in ("HUMAN_REVISED_BY_AI", "HUMAN_WITH_AI_INSERTS", "AI_WITH_HUMAN_INSERTS"):
        for i in range(c.get(cls, 0)):
            try:
                r = hp.iloc[next(hit)]
            except StopIteration:
                break
            sents = [s for s in re.split(r"(?<=[.!?])\s+", r["text"]) if s.strip()]
            lang = r["language"]
            meta = {"field": r["field"], "topic": r["topic"], "source_row": r["id"]}
            if cls == "HUMAN_REVISED_BY_AI":
                mode = rng.choice(["improve fluency and cohesion", "make it more formal and precise", "rewrite it with different words keeping the content",
                                   "polish the style and condense slightly"])
                p = f"Revise the following academic text to {mode}. Keep the same language ({LANG_NAME[lang]}). Output only the revised text.\n\n{r['text']}"
                meta["revision_mode"] = mode
            elif cls == "HUMAN_WITH_AI_INSERTS":
                if len(sents) < 3:
                    continue
                pos = rng.randint(1, len(sents) - 1)
                n_new = rng.choice([1, 2])
                p = (f"Write {n_new} new sentence(s) in {LANG_NAME[lang]} that fit naturally between PART A and PART B, same register. Output only "
                     f"the new sentence(s).\n\nPART A (end):\n{' '.join(sents[max(0, pos - 2):pos])}\n\nPART B (start):\n{' '.join(sents[pos:pos + 2])}")
                meta.update({"insert_pos_sentence": pos, "n_inserted_sentences": n_new})
            else:
                if len(sents) < 2:
                    continue
                j = rng.randint(0, len(sents) - 2)
                keep = " ".join(sents[j:j + rng.choice([1, 2])])
                p = (f"Write an original academic paragraph in {LANG_NAME[lang]} in two parts surrounding the quoted sentence(s): PART 1 goes before "
                     f"and PART 2 after, 60-150 words each, same topic and register. Do not repeat the quote. Exact format:\nPART 1:\n<text>\nPART 2:\n<text>\n\n"
                     f"QUOTE:\n{keep}")
                meta["human_excerpt_sha256"] = sha256_text(keep)
                r = r.copy()
                r["excerpt"] = keep
            reqs.append({"custom_id": f"{name}:{cls[:4].lower()}:{i:05d}", "cls": cls, "lang": lang, "prompt": p, "meta": meta,
                         "temperature": rng.choice(TEMPS), "parent_id": r["parent_id"], "group_id": r["group_id"], "side": venue_side(r["venue"]),
                         "human_text": r["text"], "human_excerpt": r.get("excerpt"), "human_sents": sents})
    return reqs


def clean(out: str) -> str:
    out = PREAMBLE.sub("", out.strip())
    out = re.sub(r"^#+\s.*\n", "", out)
    return norm_text(out.strip().strip("\"«»“”"))


def assemble(r: dict, out: str) -> dict | None:
    out = clean(out)
    cls, spans, frac = r["cls"], None, 1.0
    if cls in ("AI_GENERATED", "AI_REVISED", "HUMAN_REVISED_BY_AI"):
        text = out
        if cls == "HUMAN_REVISED_BY_AI":
            import difflib

            frac = round(1 - difflib.SequenceMatcher(None, r["human_text"], out, autojunk=False).ratio(), 3)
    elif cls == "HUMAN_WITH_AI_INSERTS":
        pos = r["meta"]["insert_pos_sentence"]
        a, b = " ".join(r["human_sents"][:pos]), " ".join(r["human_sents"][pos:])
        ins = " ".join(out.split())
        text = f"{a} {ins} {b}"
        spans = [[len(a) + 1, len(a) + 1 + len(ins)]]
        frac = round(len(ins) / len(text), 3)
    else:
        m = re.search(r"PART\s*1\s*:?\s*(.+?)\s*PART\s*2\s*:?\s*(.+)", out, re.S | re.I)
        if not m:
            return None
        p1, p2 = " ".join(m.group(1).split()), " ".join(m.group(2).split())
        h = r["human_excerpt"]
        text = f"{p1} {h} {p2}"
        spans = [[0, len(p1)], [len(p1) + len(h) + 2, len(text)]]
        frac = round((len(p1) + len(p2)) / len(text), 3)
    n = len(text.split())
    if n < 40 or n > 900:
        return None
    return {"text": text, "span_labels": json.dumps(spans) if spans else None, "ai_fraction": frac, "n_words": n}


class Engine:
    def __init__(self, hf: str):
        self.hf = hf
        self.v = None
        try:
            from vllm import LLM

            self.v = LLM(model=hf, dtype="bfloat16", max_model_len=4096, gpu_memory_utilization=0.88, trust_remote_code=True)
            self.tok = self.v.get_tokenizer()
            log(f"vLLM engine for {hf}")
        except Exception as e:  # noqa: BLE001
            log(f"vLLM unavailable ({type(e).__name__}: {str(e)[:150]}); using transformers")
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer

            self.tok = AutoTokenizer.from_pretrained(hf, padding_side="left", trust_remote_code=True)
            if self.tok.pad_token is None:
                self.tok.pad_token = self.tok.eos_token
            self.m = AutoModelForCausalLM.from_pretrained(hf, torch_dtype=torch.bfloat16, device_map="cuda", trust_remote_code=True).eval()
        from huggingface_hub import HfApi

        self.revision = HfApi().model_info(hf).sha

    def chat(self, p: str) -> str:
        return self.tok.apply_chat_template([{"role": "user", "content": p}], tokenize=False, add_generation_prompt=True)

    def run(self, prompts: list[str], temp: float) -> list[str]:
        texts = [self.chat(p) for p in prompts]
        if self.v is not None:
            from vllm import SamplingParams

            outs = self.v.generate(texts, SamplingParams(temperature=temp, top_p=0.95, max_tokens=950, seed=SEED))
            return [o.outputs[0].text for o in outs]
        import torch

        import os

        bs = int(os.environ.get("GEN_BATCH", "128" if torch.cuda.get_device_properties(0).total_memory > 70 * 2**30 else "64"))
        res = []
        for i in range(0, len(texts), bs):
            enc = self.tok(texts[i:i + bs], return_tensors="pt", padding=True).to("cuda")
            with torch.no_grad():
                g = self.m.generate(**enc, do_sample=True, temperature=temp, top_p=0.95, max_new_tokens=950, pad_token_id=self.tok.pad_token_id)
            res += self.tok.batch_decode(g[:, enc["input_ids"].shape[1]:], skip_special_tokens=True)
        return res


def run_generator(name: str) -> int:
    g = OPEN_GENERATORS[name]
    MULTI.mkdir(parents=True, exist_ok=True)
    out = MULTI / f"open_{name}.parquet"
    done = pd.read_parquet(out) if out.exists() else pd.DataFrame(columns=["custom_id"])
    reqs = {r["custom_id"]: r for r in plan(name)}
    eng = None
    for phase in (1, 2):
        if phase == 2:
            if g["role"] != "TRAIN":
                break
            gen = done[done["cls"] == "AI_GENERATED"].sample(min(COUNTS["TRAIN"]["AI_REVISED"], int((done["cls"] == "AI_GENERATED").sum())), random_state=SEED)
            for i, r in enumerate(gen.itertuples(index=False)):
                mode = random.Random(f"{SEED}:{r.custom_id}").choice(["rewrite it with different words and structure", "make it more concise",
                                                                       "make it more technical", "use a simpler register"])
                reqs[f"{name}:airev:{i:05d}"] = {"custom_id": f"{name}:airev:{i:05d}", "cls": "AI_REVISED", "lang": r.language,
                                                 "prompt": f"{mode.capitalize()}. Keep the language ({LANG_NAME[r.language]}). Output only the text.\n\n{r.text}",
                                                 "meta": {"revision_mode": mode, "revised_from": r.custom_id}, "temperature": 0.8,
                                                 "parent_id": r.parent_id, "group_id": r.group_id, "side": r.side}
        todo = [r for r in reqs.values() if r["custom_id"] not in set(done["custom_id"]) and (r["cls"] == "AI_REVISED") == (phase == 2)]
        if not todo:
            continue
        if eng is None:
            eng = Engine(g["hf"])
        log(f"{name} phase {phase}: {len(todo):,} requests")
        for t in sorted({r["temperature"] for r in todo}):
            chunk = [r for r in todo if r["temperature"] == t]
            for i in range(0, len(chunk), 512):
                part = chunk[i:i + 512]
                outs = eng.run([r["prompt"] for r in part], t)
                rows = []
                for r, o in zip(part, outs):
                    a = assemble(r, o)
                    if a is None:
                        continue
                    rows.append({"custom_id": r["custom_id"], "id": stable_id("open", r["custom_id"], sha256_text(a["text"])), "cls": r["cls"],
                                 "fine_label": FINE[r["cls"]], "label": 1, "dataset": "open_llm_multilingual", "generator": name,
                                 "provider": g["provider"], "model": g["hf"], "model_version": eng.revision,
                                 "generation_date": time.strftime("%Y-%m-%d", time.gmtime()), "language": r["lang"],
                                 "prompt_family": f"{r['cls']}|{r['meta'].get('section', 'derived')}", "domain": "academic",
                                 "field": r["meta"].get("field"), "topic": r["meta"].get("topic"), "temperature": r["temperature"],
                                 "generation_type": r["cls"], "role": g["role"], "side": r["side"], "parent_id": r["parent_id"],
                                 "group_id": r["group_id"], "text_sha256": sha256_text(a["text"]), "transformation_type": r["cls"],
                                 "meta": json.dumps(r["meta"], ensure_ascii=False), **a})
                done = pd.concat([done, pd.DataFrame(rows)], ignore_index=True).drop_duplicates("custom_id")
                done.to_parquet(out, index=False)
                log(f"  {name} t={t}: {len(done):,} rows")
    if eng is not None:
        del eng
        import gc

        import torch

        gc.collect()
        torch.cuda.empty_cache()
    write_json(MULTI / f"open_{name}.json", {"generator": name, **g, "rows": int(len(done)), "by_class": done["cls"].value_counts().to_dict(),
                                            "by_language": done["language"].value_counts().to_dict(), "by_side": done["side"].value_counts().to_dict()})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gen", choices=list(OPEN_GENERATORS))
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    names = list(OPEN_GENERATORS) if a.all else [a.gen]
    for n in names:
        run_generator(n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
