"""F006.2: Claude as an AUXILIARY source of Spanish academic TRAINING data (Message Batches API, 50 % price).

    python scripts/f0062_claude.py plan          # deterministic request plan + cost estimate (no API call)
    python scripts/f0062_claude.py run           # submit / poll / collect, resumable (state on Drive)

Rules (task F006.2): the key is read from the Colab secret / env ANTHROPIC_API_KEY and never printed or stored; models are
NOT hardcoded: CLAUDE_GEN_MODELS="id1,id2,..." if set, else the newest Opus / Sonnet / Haiku returned by the Models API.
Claude rows are TRAIN / VALIDATION / CALIBRATION only, never FINAL_EXTERNAL_HOLDOUT. Prompts are abstract topics; human text is
only used as the object of a transformation (revision / insertion) of NON-final TDX theses, and the derived row keeps the
thesis as parent (it follows the thesis split). Simulated citations must be fictitious.

Classes (experimental; MIXED is never collapsed into MACHINE):
  AI_GENERATED          -> fine AI_GENERATED      (ai_fraction 1.0)
  AI_REVISED            -> fine PARAPHRASED_AI    (Claude rewrites a Claude paragraph; same parent / group)
  HUMAN_REVISED_BY_AI   -> fine AI_EDITED         (Claude revises a TDX paragraph; ai_fraction estimated from edit distance)
  AI_WITH_HUMAN_INSERTS -> fine MIXED + spans     (Claude writes before/after 1-2 verbatim TDX sentences; spans exact)
  HUMAN_WITH_AI_INSERTS -> fine MIXED + spans     (Claude writes 1-2 sentences inserted into a TDX paragraph; spans exact)
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0062_common import MANI, NORM, SEED, length_bucket, norm_text, sha256_text, stable_id, unit, write_json  # noqa: E402

COUNTS = {"AI_GENERATED": 12000, "HUMAN_REVISED_BY_AI": 1500, "HUMAN_WITH_AI_INSERTS": 1500, "AI_WITH_HUMAN_INSERTS": 1500, "AI_REVISED": 1500}
FINE = {"AI_GENERATED": "AI_GENERATED", "AI_REVISED": "PARAPHRASED_AI", "HUMAN_REVISED_BY_AI": "AI_EDITED",
        "AI_WITH_HUMAN_INSERTS": "MIXED", "HUMAN_WITH_AI_INSERTS": "MIXED"}
FAMILY_SHARE = {"opus": 0.15, "sonnet": 0.50, "haiku": 0.35}
# Batch prices per 1M tokens (50 % of list); only used for the pre-submit estimate / cap
BATCH_PRICE = {"opus": (2.0, 10.0), "sonnet": (1.0, 5.0), "haiku": (0.05, 0.25)}
MAX_USD = float(os.environ.get("CLAUDE_MAX_USD", "90"))
STATE = MANI / "claude_batches_f006_2.json"
OUT = NORM / "claude_es_academic.parquet"
CHUNK = 4000

DOMAINS = {
    "tesis": ["planteamiento del problema", "justificación del estudio", "alcances y limitaciones", "hipótesis de trabajo", "conclusiones generales"],
    "metodología": ["diseño de investigación", "población y muestra", "instrumentos de recolección", "validez y confiabilidad", "procedimiento de análisis"],
    "marco teórico": ["antecedentes conceptuales", "definición de variables", "enfoques teóricos en tensión", "evolución histórica del concepto", "modelo conceptual propuesto"],
    "discusión": ["contraste con estudios previos", "implicaciones prácticas", "explicaciones alternativas", "limitaciones del hallazgo", "líneas futuras"],
    "resultados": ["estadística descriptiva", "comparación entre grupos", "análisis de regresión", "hallazgos cualitativos", "resultados inesperados"],
    "ingeniería": ["eficiencia energética de sistemas", "mantenimiento predictivo", "diseño estructural", "control de procesos industriales", "gestión de recursos hídricos"],
    "informática": ["aprendizaje automático aplicado", "seguridad de aplicaciones web", "arquitectura de microservicios", "procesamiento de lenguaje natural", "calidad de software"],
    "medicina": ["adherencia terapéutica", "factores de riesgo cardiovascular", "salud mental en atención primaria", "resistencia antimicrobiana", "cuidados de enfermería"],
    "ciencias sociales": ["participación ciudadana", "migración y trabajo", "desigualdad territorial", "redes sociales y opinión pública", "violencia de género"],
    "administración": ["gestión del talento", "cadena de suministro", "responsabilidad social empresarial", "planeamiento estratégico", "finanzas de pymes"],
    "educación": ["evaluación formativa", "educación inclusiva", "competencias digitales docentes", "aprendizaje basado en proyectos", "deserción universitaria"],
}
CONTEXTS = ["en un país latinoamericano", "en España", "en una universidad pública", "en una región rural", "en una ciudad intermedia",
            "en el sector público", "en pequeñas empresas", "en hospitales de segundo nivel", "en estudiantes de secundaria", "en el periodo 2015-2023"]
LENGTHS = {"120-250": (120, 250), "250-450": (250, 450), "450-700": (450, 700)}
KNOBS = {
    "tono": ["neutro y expositivo", "argumentativo", "crítico", "prudente y matizado", "divulgativo pero riguroso"],
    "estructura": ["un solo párrafo continuo", "dos párrafos", "párrafo con una enumeración breve integrada", "párrafo con definición inicial y desarrollo"],
    "persona": ["impersonal (se + verbo)", "primera persona del plural", "primera persona del singular", "tercera persona"],
    "densidad": ["baja", "media", "alta"],
    "oraciones": ["cortas", "variadas", "largas y subordinadas"],
    "conectores": ["pocos conectores", "conectores académicos frecuentes (no obstante, en consecuencia, asimismo)", "conectores variados y poco frecuentes"],
    "citas": ["sin citas", "una cita simulada", "dos o tres citas simuladas"],
}
SYSTEM = ("Eres un generador de datos sintéticos para investigación en detección de texto. Escribes en español académico "
          "original. Nunca copies ni parafrasees textos existentes; si se piden citas, usa autores y años inventados con el formato "
          "(Apellido, año). Responde solo con el texto pedido, sin títulos, comillas ni comentarios.")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def tdx_side(group_id: str) -> str:
    """Thesis split, shared with f0062_splits.py (whole-thesis split; FINAL theses are never shown to Claude)."""
    u = unit(group_id)
    return "TRAIN" if u < 0.60 else "VAL" if u < 0.72 else "CAL" if u < 0.80 else "FINAL"


def topic_side(topic_id: str) -> str:
    u = unit("claude:" + topic_id)
    return "TRAIN" if u < 0.80 else "VAL" if u < 0.90 else "CAL"


def resolve_models(client) -> dict:
    env = os.environ.get("CLAUDE_GEN_MODELS", "").strip()
    fam = lambda m: next((f for f in FAMILY_SHARE if f in m), None)  # noqa: E731
    if env:
        ids = [m.strip() for m in env.split(",") if m.strip()]
    else:
        listed = [(m.id, getattr(m, "created_at", None)) for m in client.models.list()]
        ids = []
        for f in FAMILY_SHARE:
            cand = sorted([x for x in listed if fam(x[0]) == f], key=lambda x: str(x[1]), reverse=True)
            if cand:
                ids.append(cand[0][0])
    out = {fam(m) or m: m for m in ids}
    if not out:
        raise SystemExit("ABORT: no Claude model resolved")
    return out


def pick_family(rng: random.Random, fams: list[str]) -> str:
    w = [FAMILY_SHARE.get(f, 0.2) for f in fams]
    return rng.choices(fams, weights=w)[0]


def gen_prompt(rng: random.Random) -> tuple[str, dict]:
    dom = rng.choice(sorted(DOMAINS))
    sub = rng.choice(DOMAINS[dom])
    ctx = rng.choice(CONTEXTS)
    lb = rng.choice(list(LENGTHS))
    lo, hi = LENGTHS[lb]
    k = {n: rng.choice(v) for n, v in KNOBS.items()}
    p = (f"Escribe un fragmento original de {lo} a {hi} palabras para la sección de «{dom}» de un trabajo académico sobre "
         f"«{sub}» {ctx}. Tono: {k['tono']}. Estructura: {k['estructura']}. Persona gramatical: {k['persona']}. "
         f"Densidad técnica: {k['densidad']}. Oraciones {k['oraciones']}; {k['conectores']}. Citas: {k['citas']} (inventadas). "
         f"Evita frases de cierre genéricas.")
    return p, {"domain": dom, "subtopic": sub, "context": ctx, "len_bucket_target": lb, "style": k}


def plan(models: dict, tdx: pd.DataFrame) -> list[dict]:
    rng = random.Random(SEED)
    fams = sorted(models)
    reqs = []
    for i in range(COUNTS["AI_GENERATED"]):
        p, meta = gen_prompt(rng)
        f = pick_family(rng, fams)
        tid = f"t{i:05d}"
        reqs.append({"custom_id": f"gen-{i:05d}", "cls": "AI_GENERATED", "family": f, "prompt": p, "meta": meta, "topic_id": tid,
                     "parent_id": f"claude:{tid}", "group_id": f"claude_es:{tid}", "side": topic_side(tid), "phase": 1})
    pool = tdx[tdx["group_id"].map(tdx_side) != "FINAL"].reset_index(drop=True)
    order = list(range(len(pool)))
    rng.shuffle(order)
    used = iter(order)
    # revisions use short paragraphs (<= 260 words) so a whole revision fits comfortably in one generation; separate seeded
    # order, so the other classes keep exactly the same selection
    short = pool.index[pool["n_words"] <= 260].tolist()
    random.Random(SEED + 5).shuffle(short)
    short_it = iter(short)
    for cls in ("HUMAN_REVISED_BY_AI", "HUMAN_WITH_AI_INSERTS", "AI_WITH_HUMAN_INSERTS"):
        for i in range(COUNTS[cls]):
            r = pool.iloc[next(used)]
            if cls == "HUMAN_REVISED_BY_AI":
                r = pool.loc[next(short_it)]
            f = pick_family(rng, fams)
            sents = [s for s in re.split(r"(?<=[.!?])\s+", r["text"]) if s.strip()]
            meta = {"domain": "tesis (TDX)", "source_row": r["id"], "len_bucket_target": r["len_bucket"]}
            if cls == "HUMAN_REVISED_BY_AI":
                mode = rng.choice(["mejorar fluidez y cohesión", "hacerlo más formal y preciso", "reescribirlo con otras palabras conservando el contenido",
                                   "corregir estilo y condensar ligeramente"])
                p = f"Revisa el siguiente párrafo académico para {mode}. Devuelve solo el párrafo revisado.\n\n{r['text']}"
                meta["revision_mode"] = mode
            elif cls == "HUMAN_WITH_AI_INSERTS":
                if len(sents) < 3:
                    continue
                pos = rng.randint(1, len(sents) - 1)
                n_new = rng.choice([1, 2])
                p = (f"A continuación hay un párrafo dividido en dos partes. Escribe {n_new} oración(es) nuevas que encajen de forma natural "
                     f"entre la PARTE A y la PARTE B, con el mismo registro. Devuelve solo esas oraciones.\n\n"
                     f"PARTE A (final):\n{' '.join(sents[max(0, pos - 2):pos])}\n\nPARTE B (inicio):\n{' '.join(sents[pos:pos + 2])}")  # local context only
                meta.update({"insert_pos_sentence": pos, "n_inserted_sentences": n_new})
            else:
                if len(sents) < 2:
                    continue
                j = rng.randint(0, len(sents) - 2)
                keep = " ".join(sents[j:j + rng.choice([1, 2])])
                p = (f"Escribe un párrafo académico original en dos partes que rodee la cita textual indicada: la PARTE 1 va antes y la "
                     f"PARTE 2 después, de 60 a 160 palabras cada una, con el mismo tema y registro. No repitas la cita. Formato exacto:\n"
                     f"PARTE 1:\n<texto>\nPARTE 2:\n<texto>\n\nCITA (no la reescribas):\n{keep}")
                meta.update({"human_excerpt_sha256": sha256_text(keep)})
                r = r.copy()
                r["excerpt"] = keep
            reqs.append({"custom_id": f"{ {'HUMAN_REVISED_BY_AI': 'hrev', 'HUMAN_WITH_AI_INSERTS': 'hins', 'AI_WITH_HUMAN_INSERTS': 'ains'}[cls]}-{i:05d}", "cls": cls, "family": f, "prompt": p, "meta": meta,
                         "topic_id": None, "parent_id": r["parent_id"], "group_id": r["group_id"], "side": tdx_side(r["group_id"]), "phase": 1,
                         "human_text": r["text"], "human_excerpt": r.get("excerpt"), "human_sents": sents})
    return reqs


def phase2(done: pd.DataFrame, models: dict) -> list[dict]:
    rng = random.Random(SEED + 2)
    gen = done[done["cls"] == "AI_GENERATED"]
    pick = gen.sample(min(COUNTS["AI_REVISED"], len(gen)), random_state=SEED)
    out = []
    for i, r in enumerate(pick.itertuples(index=False)):
        f = pick_family(rng, sorted(models))
        mode = rng.choice(["reescríbelo con otras palabras y otra estructura", "hazlo más conciso", "hazlo más técnico", "cámbialo a un registro más sencillo"])
        out.append({"custom_id": f"airev-{i:05d}", "cls": "AI_REVISED", "family": f, "prompt": f"{mode.capitalize()}. Devuelve solo el texto.\n\n{r.text}",
                    "meta": {"revision_mode": mode, "revised_from": r.id, "domain": r.domain}, "topic_id": r.topic_id, "parent_id": r.parent_id,
                    "group_id": r.group_id, "side": r.side, "phase": 2})
    return out


def estimate(reqs: list[dict]) -> float:
    usd = 0.0
    for r in reqs:
        pin, pout = BATCH_PRICE.get(r["family"], (1.0, 5.0))
        tin = len(r["prompt"]) / 3.5 + 120
        tout = 1100 if r["cls"] == "AI_GENERATED" else 900
        usd += tin / 1e6 * pin + tout / 1e6 * pout
    return usd


def params(r: dict, models: dict) -> dict:
    return {"model": models[r["family"]], "max_tokens": 6000, "system": SYSTEM, "output_config": {"effort": "low"},
            "messages": [{"role": "user", "content": r["prompt"]}]}


def assemble(r: dict, out: str) -> dict | None:
    out = norm_text(out.strip().strip("«»\"'"))
    cls, spans, frac = r["cls"], None, 1.0
    if cls in ("AI_GENERATED", "AI_REVISED"):
        text = out
    elif cls == "HUMAN_REVISED_BY_AI":
        text = out
        frac = round(1 - difflib.SequenceMatcher(None, r["human_text"], out, autojunk=False).ratio(), 3)
    elif cls == "HUMAN_WITH_AI_INSERTS":
        pos = r["meta"]["insert_pos_sentence"]
        a, b = " ".join(r["human_sents"][:pos]), " ".join(r["human_sents"][pos:])
        ins = " ".join(out.split())
        text = f"{a} {ins} {b}"
        spans = [[len(a) + 1, len(a) + 1 + len(ins)]]
        frac = round(len(ins) / len(text), 3)
    else:
        m = re.search(r"PARTE 1:\s*(.+?)\s*PARTE 2:\s*(.+)", out, re.S)
        if not m:
            return None
        p1, p2 = " ".join(m.group(1).split()), " ".join(m.group(2).split())
        h = r["human_excerpt"]
        text = f"{p1} {h} {p2}"
        spans = [[0, len(p1)], [len(p1) + len(h) + 2, len(text)]]
        frac = round((len(p1) + len(p2)) / len(text), 3)
    n = len(text.split())
    if n < 40 or (cls != "AI_WITH_HUMAN_INSERTS" and cls != "HUMAN_WITH_AI_INSERTS" and n > 900):
        return None
    return {"text": text, "span_labels": json.dumps(spans) if spans else None, "ai_fraction": frac, "n_words": n, "len_bucket": length_bucket(n)}


def run() -> int:
    import anthropic

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ABORT: ANTHROPIC_API_KEY not set (Colab secret)")
    client = anthropic.Anthropic()
    st = json.loads(STATE.read_text()) if STATE.exists() else {"batches": {}, "models": None}
    models = st["models"] or resolve_models(client)
    st["models"] = models
    tdx = pd.read_parquet(NORM / "tdx_thesis_es.parquet")
    reqs = {r["custom_id"]: r for r in plan(models, tdx)}
    results = pd.read_parquet(OUT) if OUT.exists() else pd.DataFrame(columns=["custom_id"])
    have = set(results["custom_id"])
    for phase in (1, 2):
        if phase == 2:
            reqs.update({r["custom_id"]: r for r in phase2(results, models)})
        todo = [r for r in reqs.values() if r["phase"] == phase and r["custom_id"] not in have
                and not any(r["custom_id"] in b["ids"] for b in st["batches"].values() if b["status"] != "failed")]
        est = estimate([r for r in reqs.values() if r["phase"] == phase])
        log(f"phase {phase}: {len(todo):,} requests to submit; models {models}; estimated phase cost ~{est:.1f} USD (cap {MAX_USD})")
        if est > MAX_USD:
            raise SystemExit(f"ABORT: estimated cost {est:.1f} USD > CLAUDE_MAX_USD {MAX_USD}")
        from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
        from anthropic.types.messages.batch_create_params import Request

        for i in range(0, len(todo), CHUNK):
            part = todo[i:i + CHUNK]
            b = client.messages.batches.create(requests=[Request(custom_id=r["custom_id"], params=MessageCreateParamsNonStreaming(**params(r, models)))
                                                         for r in part])
            st["batches"][b.id] = {"ids": [r["custom_id"] for r in part], "status": "submitted", "phase": phase,
                                   "submittedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            write_json(STATE, st)
            log(f"submitted batch {b.id} ({len(part)} requests)")
        while True:
            pend = [bid for bid, b in st["batches"].items() if b["phase"] == phase and b["status"] == "submitted"]
            if not pend:
                break
            for bid in pend:
                b = client.messages.batches.retrieve(bid)
                if b.processing_status != "ended":
                    continue
                rows = []
                for res in client.messages.batches.results(bid):
                    r = reqs.get(res.custom_id)
                    if r is None or res.result.type != "succeeded":
                        continue
                    msg = res.result.message
                    if msg.stop_reason not in ("end_turn", "stop_sequence"):
                        continue
                    txt = next((c.text for c in msg.content if c.type == "text"), "")
                    a = assemble(r, txt)
                    if a is None:
                        continue
                    rows.append({"custom_id": r["custom_id"], "id": stable_id("claude_es", r["custom_id"], sha256_text(a["text"])), "cls": r["cls"],
                                 "fine_label": FINE[r["cls"]], "label": 1, "dataset": "claude_es_academic", "generator": msg.model,
                                 "provider": "anthropic", "model": msg.model, "generation_date": time.strftime("%Y-%m-%d", time.gmtime()),
                                 "prompt_family": f"{r['cls']}|{r['meta'].get('domain')}", "temperature": "model_default",
                                 "max_tokens": 6000, "effort": "low", "domain": "academic", "style": json.dumps(r["meta"].get("style"), ensure_ascii=False),
                                 "seed_id": f"{SEED}:{r['custom_id']}", "text_sha256": sha256_text(a["text"]), "parent_id": r["parent_id"],
                                 "parent_source_id": r["parent_id"], "group_id": r["group_id"], "topic_id": r["topic_id"], "side": r["side"],
                                 "language": "es", "transformation_type": r["cls"], "meta": json.dumps(r["meta"], ensure_ascii=False),
                                 "usage_in": msg.usage.input_tokens, "usage_out": msg.usage.output_tokens, **a})
                results = pd.concat([results, pd.DataFrame(rows)], ignore_index=True).drop_duplicates("custom_id")
                results.to_parquet(OUT, index=False)
                have = set(results["custom_id"])
                st["batches"][bid]["status"] = "collected"
                st["batches"][bid]["kept"] = len(rows)
                write_json(STATE, st)
                log(f"collected {bid}: kept {len(rows)}; total {len(results):,}")
            if any(b["status"] == "submitted" for b in st["batches"].values() if b["phase"] == phase):
                time.sleep(120)
    usage = {"input_tokens": int(results["usage_in"].sum()), "output_tokens": int(results["usage_out"].sum())}
    write_json(MANI / "claude_es_academic.json", {"rows": int(len(results)), "by_class": results["cls"].value_counts().to_dict(),
                                                  "by_model": results["model"].value_counts().to_dict(), "by_side": results["side"].value_counts().to_dict(),
                                                  "usage": usage, "models": models, "never_in_final_holdout": True,
                                                  "file_sha256": __import__("hashlib").sha256(OUT.read_bytes()).hexdigest()})
    log(f"Claude data complete: {len(results):,} rows")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["plan", "run"])
    a = ap.parse_args()
    if a.cmd == "plan":
        tdx = pd.read_parquet(NORM / "tdx_thesis_es.parquet")
        reqs = plan({f: f for f in FAMILY_SHARE}, tdx)
        print(json.dumps({"requests_phase1": len(reqs), "by_class": pd.Series([r["cls"] for r in reqs]).value_counts().to_dict(),
                          "estimated_usd_phase1": round(estimate(reqs), 1)}, indent=2))
        return 0
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
