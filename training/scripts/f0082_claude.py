"""F008.2: Claude-generated paraphrase / hard-negative pairs — TRAINING DATA ONLY (never validation, calibration or holdout).

    python scripts/f0082_claude.py plan
    python scripts/f0082_claude.py run        # Message Batches (50 % price), resumable; key from the Colab secret ANTHROPIC_API_KEY

One request per seed: Claude writes an original Spanish academic seed passage (abstract topic, fictitious data / entities) and,
with structured output, every transformation of it. All rows derived from a seed share parent_source_id = the seed, so a seed and
all its transformations always land in one split (TRAIN). Models are not hardcoded: CLAUDE_GEN_MODELS or the newest Sonnet / Haiku
/ Opus from the Models API. The key is never printed or stored.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import MANI, PAIRS, SEED, norm_text, sha256_text, write_json  # noqa: E402

N_SEEDS = int(os.environ.get("F0082_SEEDS", "2000"))
FAMILY_SHARE = {"sonnet": 0.55, "haiku": 0.35, "opus": 0.10}
BATCH_PRICE = {"opus": (2.0, 10.0), "sonnet": (1.0, 5.0), "haiku": (0.05, 0.25)}
MAX_USD = float(os.environ.get("CLAUDE_MAX_USD_F0082", "30"))
STATE = MANI / "claude_batches_f008_2.json"
OUT = PAIRS / "claude_pairs.parquet"
CHUNK = 2000
TOPICS = ["salud pública", "educación superior", "ingeniería civil", "economía regional", "energías renovables", "seguridad informática", "agricultura",
          "psicología clínica", "derecho administrativo", "transporte urbano", "biología marina", "gestión empresarial", "lingüística", "historia contemporánea",
          "ciencia de datos", "nutrición", "arquitectura sostenible", "turismo", "comunicación política", "química ambiental"]
FIELDS = {"seed": "pasaje original (2-3 oraciones, 40-90 palabras) con al menos un número, una entidad ficticia y una relación causal",
          "FAITHFUL_PARAPHRASE": "mismo significado exacto, cambios léxicos moderados",
          "STRONG_PARAPHRASE": "mismo significado, vocabulario y estructura muy distintos",
          "PARTIAL_PARAPHRASE": "conserva solo parte del contenido (omite o agrega una idea)",
          "STRUCTURAL_REWRITE": "mismo significado, reorganiza el orden de las ideas y la sintaxis (voz pasiva, subordinadas)",
          "TRANSLATED_PARAPHRASE": "traducción fiel al inglés",
          "LEXICAL_HARD_NEGATIVE": "reutiliza casi todas las palabras del original pero dice otra cosa",
          "NEGATION_HARD_NEGATIVE": "igual al original salvo que niega o invierte la afirmación principal",
          "NUMBER_CHANGED_NEGATIVE": "igual al original salvo que cambia los números o su dirección (sube/baja)",
          "ENTITY_CHANGED_NEGATIVE": "igual al original salvo que cambia la entidad, el lugar o el agente",
          "CAUSALITY_CHANGED_NEGATIVE": "mismas ideas pero invierte o elimina la relación de causa y efecto",
          "SAME_TOPIC_NEGATIVE": "mismo tema, afirmación distinta, poco vocabulario compartido"}
SCHEMA = {"type": "object", "additionalProperties": False, "required": list(FIELDS), "properties": {k: {"type": "string"} for k in FIELDS}}
SYSTEM = ("Generas datos sintéticos para entrenar un detector de paráfrasis en español. Todo es original e inventado (entidades, cifras y "
          "autores ficticios); nunca copias textos reales. Los negativos deben parecerse mucho en forma al original pero NO significar lo mismo.")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def resolve_models(client) -> dict:
    env = os.environ.get("CLAUDE_GEN_MODELS", "").strip()
    fam = lambda m: next((f for f in FAMILY_SHARE if f in m), None)  # noqa: E731
    ids = [m.strip() for m in env.split(",") if m.strip()] if env else []
    if not ids:
        listed = [(m.id, getattr(m, "created_at", None)) for m in client.models.list()]
        for f in FAMILY_SHARE:
            c = sorted([x for x in listed if fam(x[0]) == f], key=lambda x: str(x[1]), reverse=True)
            if c:
                ids.append(c[0][0])
    return {fam(m) or m: m for m in ids}


def plan(models: dict) -> list[dict]:
    rng = random.Random(SEED)
    fams = sorted(models)
    out = []
    for i in range(N_SEEDS):
        topic = rng.choice(TOPICS)
        reg = rng.choice(["formal académico", "técnico", "divulgativo riguroso"])
        p = (f"Tema: {topic}. Registro: {reg}. Variante {i}. Devuelve un objeto JSON con estos campos:\n"
             + "\n".join(f"- {k}: {v}" for k, v in FIELDS.items())
             + "\nTodos los campos derivados se refieren al mismo 'seed'. Escribe en español salvo TRANSLATED_PARAPHRASE.")
        f = rng.choices(fams, weights=[FAMILY_SHARE.get(x, 0.2) for x in fams])[0]
        out.append({"custom_id": f"seed-{i:05d}", "family": f, "prompt": p, "topic": topic, "register": reg})
    return out


def estimate(reqs) -> float:
    return sum((len(r["prompt"]) / 3.5 + 200) / 1e6 * BATCH_PRICE.get(r["family"], (1, 5))[0] + 1500 / 1e6 * BATCH_PRICE.get(r["family"], (1, 5))[1]
               for r in reqs)


def valid(field: str, seed: str, txt: str) -> bool:
    import re

    if not txt or len(txt.split()) < 8 or txt.strip() == seed.strip():
        return False
    if field == "NUMBER_CHANGED_NEGATIVE":
        return re.findall(r"\d+(?:[.,]\d+)?", txt) != re.findall(r"\d+(?:[.,]\d+)?", seed)
    return True


def run() -> int:
    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ABORT: ANTHROPIC_API_KEY not set (Colab secret)")
    client = anthropic.Anthropic()
    st = json.loads(STATE.read_text()) if STATE.exists() else {"batches": {}, "models": None}
    models = st["models"] or resolve_models(client)
    st["models"] = models
    reqs = {r["custom_id"]: r for r in plan(models)}
    est = estimate(reqs.values())
    log(f"{len(reqs):,} seed requests; models {models}; estimated ~{est:.1f} USD (cap {MAX_USD})")
    if est > MAX_USD:
        raise SystemExit("ABORT: estimated cost above CLAUDE_MAX_USD_F0082")
    res = pd.read_parquet(OUT) if OUT.exists() else pd.DataFrame(columns=["seed_custom_id"])
    have = set(res["seed_custom_id"])
    sent = {i for b in st["batches"].values() for i in b["ids"] if b["status"] != "failed"}
    todo = [r for r in reqs.values() if r["custom_id"] not in have and r["custom_id"] not in sent]
    for i in range(0, len(todo), CHUNK):
        part = todo[i:i + CHUNK]
        b = client.messages.batches.create(requests=[Request(custom_id=r["custom_id"], params=MessageCreateParamsNonStreaming(
            model=models[r["family"]], max_tokens=8000, system=SYSTEM, output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": r["prompt"]}])) for r in part])
        st["batches"][b.id] = {"ids": [r["custom_id"] for r in part], "status": "submitted"}
        write_json(STATE, st)
        log(f"submitted {b.id} ({len(part)})")
    while any(b["status"] == "submitted" for b in st["batches"].values()):
        for bid, binfo in list(st["batches"].items()):
            if binfo["status"] != "submitted" or client.messages.batches.retrieve(bid).processing_status != "ended":
                continue
            rows = []
            for r in client.messages.batches.results(bid):
                q = reqs.get(r.custom_id)
                if q is None or r.result.type != "succeeded" or r.result.message.stop_reason != "end_turn":
                    continue
                msg = r.result.message
                try:
                    obj = json.loads(next(c.text for c in msg.content if c.type == "text"))
                except Exception:  # noqa: BLE001
                    continue
                seed = norm_text(obj.get("seed", ""))
                if len(seed.split()) < 20:
                    continue
                sid = f"claude_seed:{r.custom_id}"
                for fld in FIELDS:
                    if fld == "seed":
                        continue
                    t = norm_text(obj.get(fld, ""))
                    if not valid(fld, seed, t):
                        continue
                    rows.append({"seed_custom_id": r.custom_id, "pair_id": f"{r.custom_id}:{fld}", "text_a": seed, "text_b": t, "pair_class": fld,
                                 "lang_b": "en" if fld == "TRANSLATED_PARAPHRASE" else "es", "dataset": "claude_pairs", "provider": "anthropic",
                                 "model": msg.model, "generation_date": time.strftime("%Y-%m-%d", time.gmtime()), "prompt_family": f"seed_bundle|{q['topic']}|{q['register']}",
                                 "temperature": "model_default", "max_tokens": 8000, "effort": "low", "domain": q["topic"], "style": q["register"],
                                 "seed_id": f"{SEED}:{r.custom_id}", "sha256": sha256_text(seed + "␟" + t), "parent_source_id": sid, "lineage": sid,
                                 "usage_in": msg.usage.input_tokens, "usage_out": msg.usage.output_tokens})
            res = pd.concat([res, pd.DataFrame(rows)], ignore_index=True)
            res.to_parquet(OUT, index=False)
            st["batches"][bid]["status"] = "collected"
            st["batches"][bid]["pairs"] = len(rows)
            write_json(STATE, st)
            log(f"collected {bid}: {len(rows)} pairs; total {len(res):,}")
        if any(b["status"] == "submitted" for b in st["batches"].values()):
            time.sleep(90)
    u = res.drop_duplicates("seed_custom_id")
    write_json(MANI / "claude_pairs.json", {"pairs": int(len(res)), "seeds": int(res["seed_custom_id"].nunique()), "by_class": res["pair_class"].value_counts().to_dict(),
                                            "by_model": res["model"].value_counts().to_dict(), "usage": {"input_tokens": int(u["usage_in"].sum()),
                                                                                                       "output_tokens": int(u["usage_out"].sum())},
                                            "rule": "TRAINING DATA ONLY"})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["plan", "run"])
    a = ap.parse_args()
    if a.cmd == "plan":
        reqs = plan({f: f for f in FAMILY_SHARE})
        print(json.dumps({"seeds": len(reqs), "expected_pairs": len(reqs) * (len(FIELDS) - 1), "estimated_usd": round(estimate(reqs), 1)}, indent=2))
        return 0
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
