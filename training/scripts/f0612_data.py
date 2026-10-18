"""F006.1.2 span-localisation data: paragraph units with exact char spans, group-safe splits, leakage gates, LOCK.

    python scripts/f0612_data.py            # builds datasets/*.parquet + manifests (no-op if the holdout is LOCKED)

Units (one paragraph-sized target, NFC text, spans re-projected through the NFC map, never re-searched):
* SPAN      V2 rows with exact AI spans (OPAI-bench mixed / AI-edited, Heterogeneous AI Spans) + their human controls.
* ES_SPLICE Spanish mixed units: a human Spanish paragraph (COWSL2H / academic abstracts / SciELO / SBW) in which 1-2
            runs of sentences are replaced by sentences of a Spanish AI generation (AuTexTification / IberAuTexTification
            / other V2 Spanish AI rows) from the SAME split side. Exact spans by construction (no ES span corpus exists).
* HUMAN     human-only paragraphs (new Spanish sources + V2 humans, academic boosted): target = no span.
* HARD_NEG  real human paragraphs matching academic boilerplate / methodology / list / heading patterns.
* REFERENCE / METADATA synthetic reference entries and front-matter blocks (fake names; target = no span).

Sides: V2 train -> TRAIN, V2 validation -> VALIDATION, V2 test-side rows never observed by any holdout -> HOLDOUT.
New-source rows: F006.1.1 TRAIN_NEW -> TRAIN; rows that no model ever trained on and no locked holdout contains are
split by group hash (40% VALIDATION / 60% HOLDOUT). Excluded everywhere from HOLDOUT: ids of eval_sets_v2, the F006,
F006.1 and F006.1.1 final holdouts. Unseen generators: families absent from every training set -> HOLDOUT only.
Unseen domains: V2 unseen_domain_test rows -> HOLDOUT only.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f0611_splits import near_dup_members  # noqa: E402
from f0612_spans import clip_spans, merge_spans, nfc_with_map, parse_spans, project_spans, unit_bounds  # noqa: E402
from f006_lib import categorical_to_str, log, sha256_file, sha256_ids, write_json  # noqa: E402
from turniting_train.splits import unit_hash  # noqa: E402
from turniting_train.textnorm import normalized_text_hash  # noqa: E402

SEED = 61206
T = Path("/content/drive/MyDrive/turniting")
D = T / "f006_1_2"
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]
TEST_SIDE = {"test", "ood_test", "unseen_domain_test"}
CAPS = {"TRAIN": {"SPAN": 70000, "ES_SPLICE": 25000, "HUMAN": 30000, "HARD_NEG": 8000, "REFERENCE": 3000, "METADATA": 3000},
        "VALIDATION": {"SPAN": 12000, "ES_SPLICE": 5000, "HUMAN": 6000, "HARD_NEG": 1500, "REFERENCE": 800, "METADATA": 800},
        "HOLDOUT": {"SPAN": 14000, "ES_SPLICE": 6000, "HUMAN": 7000, "HARD_NEG": 2000, "REFERENCE": 1000, "METADATA": 1000}}
BOILER = re.compile(r"(metodolog|objetivo|resultados|conclusi|se realizó un estudio|enfoque cuantitativo|diseño no experimental|"
                    r"the aim of this|methodology|results show|in conclusion|this study|^\s*(\d+\.|[-•*])\s)", re.I | re.M)
SENT = re.compile(r"[^.!?]+[.!?]+[\"'”’)\]]*\s*")


def h(x: str) -> float:
    return unit_hash(str(x), SEED)


# ------------------------------------------------------------------ text access
def master_texts(ids_by_split: dict) -> pd.DataFrame:
    parts = []
    for split, ids in ids_by_split.items():
        if ids:
            parts.append(pads.dataset(str(MASTER / split), format="parquet").to_table(
                columns=["id", "text_original", "span_labels"], filter=pc.field("id").isin(list(ids))).to_pandas())
    return pd.concat(parts, ignore_index=True).drop_duplicates("id") if parts else pd.DataFrame(columns=["id", "text_original", "span_labels"])


def to_units(row: dict, text: str, spans: list, kind: str, max_units: int = 3) -> list[dict]:
    nfc, src = nfc_with_map(text)
    sp = project_spans(spans, src) if spans else []
    out = []
    for k, (s, e) in enumerate(unit_bounds(nfc)):
        u = nfc[s:e]
        if len(u) < 120 or len(u.split()) < 20:
            continue
        us = merge_spans(clip_spans(sp, s, e))
        out.append({**row, "unit_id": f"{row['id']}#u{k}", "text": u, "spans": json.dumps(us), "n_spans": len(us),
                    "ai_fraction_chars": sum(b - a for a, b in us) / len(u), "kind": kind})
    if kind == "SPAN":  # prefer units that carry spans, keep some span-free units of mixed docs as in-doc negatives
        pos = [x for x in out if x["n_spans"]]
        neg = [x for x in out if not x["n_spans"]]
        out = pos[:max_units] + neg[:1]
    return out[:max_units]


# ------------------------------------------------------------------ synthetic negatives
FIRST = ["Ana", "Luis", "María", "José", "Lucía", "Carlos", "Elena", "Jorge", "Sofía", "Diego", "Laura", "Pablo", "Wei", "John", "Priya", "Omar"]
LAST = ["García", "Quispe", "Huamán", "Rodríguez", "Mamani", "Torres", "Flores", "Rojas", "Smith", "Chen", "Kumar", "Silva", "Vargas", "Castro"]
WORDS = ["análisis", "educación", "modelo", "impacto", "gestión", "calidad", "aprendizaje", "salud", "sistema", "evaluación", "desarrollo",
         "learning", "framework", "policy", "network", "assessment", "urban", "water", "energy", "students", "rural", "digital"]


def fake_ref(rng):
    au = ", ".join(f"{rng.choice(LAST)}, {rng.choice(FIRST)[0]}." for _ in range(rng.randint(1, 4)))
    title = " ".join(rng.choice(WORDS) for _ in range(rng.randint(5, 11))).capitalize()
    y = rng.randint(1995, 2025)
    doi = f"https://doi.org/10.{rng.randint(1000, 9999)}/{rng.choice(['j', 'rev', 's'])}.{rng.randint(100000, 999999)}"
    style = rng.random()
    if style < 0.5:
        return f"{au} ({y}). {title}. Revista de {rng.choice(WORDS).capitalize()}, {rng.randint(1, 60)}({rng.randint(1, 12)}), {rng.randint(1, 300)}-{rng.randint(301, 600)}. {doi}"
    if style < 0.8:
        return f"{au} {title}. {rng.choice(['Journal of', 'Revista'])} {rng.choice(WORDS).capitalize()}. {y};{rng.randint(1, 60)}:{rng.randint(1, 900)}. doi:{doi[16:]}"
    return f"[{rng.randint(1, 80)}] {au}, \"{title},\" in Proc. {rng.choice(WORDS).capitalize()} Conf., {y}, pp. {rng.randint(1, 99)}-{rng.randint(100, 200)}."


def fake_meta(rng):
    n = f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)}"
    adv = f"{rng.choice(['Dr.', 'Mg.', 'Dra.'])} {rng.choice(FIRST)} {rng.choice(LAST)}"
    uni = f"Universidad {rng.choice(['Nacional', 'Privada', 'Católica'])} de {rng.choice(['Lima', 'Arequipa', 'Trujillo', 'Cusco', 'Piura'])}"
    lines = [f"Autor: {n}", f"ORCID: 0000-000{rng.randint(1, 9)}-{rng.randint(1000, 9999)}-{rng.randint(1000, 9999)}",
             f"Correo: {n.split()[0].lower()}.{n.split()[1].lower()}@{rng.choice(['gmail.com', 'unmsm.edu.pe', 'pucp.edu.pe', 'uni.edu.pe'])}",
             f"Asesor: {adv}", uni, f"Facultad de {rng.choice(['Ingeniería', 'Educación', 'Ciencias de la Salud', 'Derecho'])}",
             f"{rng.choice(['Lima', 'Arequipa'])}, {rng.randint(1, 28)} de {rng.choice(['marzo', 'julio', 'octubre'])} de {rng.randint(2015, 2026)}",
             f"Tesis para optar el título profesional de {rng.choice(['Ingeniero Civil', 'Licenciada en Educación', 'Abogado'])}"]
    rng.shuffle(lines)
    return "\n".join(lines[: rng.randint(4, 8)])


def synthetic(kind: str, n: int, side: str) -> list[dict]:
    rng = random.Random(f"{SEED}:{kind}:{side}")
    out = []
    for i in range(n):
        if kind == "REFERENCE":
            head = rng.choice(["Referencias", "Referencias bibliográficas", "Bibliografía", "References"])
            text = head + "\n" + "\n".join(fake_ref(rng) for _ in range(rng.randint(3, 9)))
        else:
            text = fake_meta(rng)
        gid = f"syn_{kind.lower()}_{side}_{i}"
        out.append({"id": gid, "unit_id": gid + "#u0", "text": text, "spans": "[]", "n_spans": 0, "ai_fraction_chars": 0.0, "kind": kind,
                    "dataset": f"synthetic_{kind.lower()}", "language": "es" if not text.startswith("References") else "en", "domain": "academic",
                    "fine_label": "HUMAN", "generator_family": "none", "group_id": gid, "parent_id": None, "subset": kind.lower()})
    return out


# ------------------------------------------------------------------ Spanish splices
def sentences(t: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in SENT.finditer(t)]


def splice(human: dict, ai_texts: list[str], rng) -> dict | None:
    """Replace 1-2 runs of 1-3 human sentences with consecutive sentences of one Spanish AI text."""
    t = human["text"]
    hs = sentences(t)
    if len(hs) < 3 or not ai_texts:
        return None
    n_runs = 2 if (len(hs) >= 6 and rng.random() < 0.3) else 1
    runs, i = [], 0
    for k in range(n_runs):
        lo = i if k == 0 else i + 1  # keep >= 1 human sentence between runs
        if lo >= len(hs):
            break
        st = rng.randrange(lo, len(hs)) if n_runs == 1 else rng.randrange(lo, max(lo + 1, (len(hs) * (k + 1)) // n_runs))
        ln = rng.randint(1, min(3, len(hs) - st))
        runs.append((st, st + ln))
        i = st + ln
    src = rng.choice(ai_texts)
    ss = sentences(src)
    out, spans, cur = "", [], 0
    for st, en in runs:
        out += t[cur: hs[st][0]]
        ln = en - st
        if len(ss) < ln:
            return None
        k = rng.randrange(0, len(ss) - ln + 1)
        ins = src[ss[k][0]: ss[k + ln - 1][1]].strip()
        if out and not out[-1].isspace():
            out += " "
        spans.append([len(out), len(out) + len(ins)])
        out += ins + " "
        cur = hs[en - 1][1]
    out += t[cur:].lstrip()
    out = out.rstrip()
    spans = [[a_, min(b_, len(out))] for a_, b_ in spans if a_ < len(out)]
    if not spans or sum(b_ - a_ for a_, b_ in spans) >= 0.9 * len(out):
        return None
    return {**human, "unit_id": human["unit_id"] + "#splice", "text": out, "spans": json.dumps(spans), "n_spans": len(spans),
            "ai_fraction_chars": sum(b_ - a_ for a_, b_ in spans) / len(out), "kind": "ES_SPLICE", "fine_label": "MIXED", "subset": "es_splice"}


# ------------------------------------------------------------------ main
def main() -> int:
    lock = D / "manifests" / "F006_1_2_HOLDOUT_LOCK.json"
    if lock.exists():
        man = json.loads(lock.read_text())
        assert sha256_file(D / "datasets" / "f006_1_2_span_final_holdout.parquet") == man["holdout_file_sha256"], "locked holdout changed"
        log("F006_1_2_SPAN_FINAL_HOLDOUT already LOCKED; verified")
        return 0
    t0 = time.time()
    for p in ("datasets", "manifests", "runs", "checkpoints", "models", "reports", "evaluation"):
        (D / p).mkdir(parents=True, exist_ok=True)
    idx = categorical_to_str(pd.read_parquet(T / "v3/datasets/index_v2.parquet"))
    idx = idx[idx["status"] == "KEPT"]
    ev_ids = set(pd.read_parquet(T / "v3/datasets/eval_sets_v2.parquet", columns=["id"])["id"])
    holds = {n: pd.read_parquet(p, columns=["id", "group_id"]) for n, p in (
        ("f006", T / "f006/datasets/f006_final_holdout.parquet"), ("f006_1", T / "f006_1/datasets/f006_1_final_holdout.parquet"),
        ("f006_1_1", T / "f006_1_1/datasets/f006_1_1_final_holdout.parquet"))}
    hold_ids = set().union(*[set(x["id"]) for x in holds.values()]) | ev_ids
    hold_groups = set().union(*[set(x["group_id"]) for x in holds.values()]) | set(idx.loc[idx["id"].isin(ev_ids), "group_id"])
    extra = pd.read_parquet(T / "f006_1_1/datasets/f006_1_1_train_extra.parquet", columns=["id", "group_id", "dataset", "fine_label", "language", "generator_family"])
    train_groups = set(idx.loc[idx["split"] == "train", "group_id"]) | set(extra["group_id"])
    trained_fams = set(idx.loc[idx["split"] == "train", "generator_family"].dropna()) | set(extra["generator_family"].dropna())

    def side_v2(r) -> str:
        if r["split"] == "train":
            return "TRAIN"
        if r["group_id"] in train_groups:
            return "NONE"
        if r["split"] == "validation":
            return "VALIDATION"
        if r["split"] in TEST_SIDE and r["id"] not in hold_ids and r["group_id"] not in hold_groups:
            return "HOLDOUT"
        return "NONE"

    # ---------------- SPAN units from V2
    sp = idx[idx["span_labels_present"].fillna(False).astype(bool)].copy()
    sp["side"] = sp.apply(side_v2, axis=1)
    sp = sp[sp["side"] != "NONE"]
    sp["unseen_generator"] = ~sp["generator_family"].isin(trained_fams) & (sp["fine_label"] != "HUMAN")
    sp.loc[sp["unseen_generator"] & (sp["side"] != "HOLDOUT"), "side"] = "NONE"  # whole unseen families: holdout only
    sp.loc[(sp["split"] == "unseen_domain_test") & (sp["side"] != "HOLDOUT"), "side"] = "NONE"
    sp = sp[sp["side"] != "NONE"]
    rng = np.random.default_rng(SEED)
    take = []
    for side, g in sp.groupby("side"):
        cap = CAPS[side]["SPAN"]
        per = max(1, cap // 2)  # units per doc ~2 -> docs needed
        take.append(g.sample(min(len(g), per), random_state=SEED))
    sp = pd.concat(take)
    tx = master_texts({s: set(g["id"]) for s, g in sp.groupby("split")})
    sp = sp.merge(tx, on="id", how="left")
    sp = sp[sp["text_original"].notna()]
    units = []
    for r in sp.to_dict("records"):
        base = {k: r[k] for k in ("id", "dataset", "language", "domain", "fine_label", "generator_family", "group_id", "parent_id", "side", "split")}
        base["subset"] = "unseen_generator" if r["unseen_generator"] else ("unseen_domain" if r["split"] == "unseen_domain_test" else "span")
        units += to_units(base, r["text_original"], parse_spans(r["span_labels"]), "SPAN")
    log(f"SPAN units {len(units):,} from {len(sp):,} docs")

    # ---------------- human pools (new sources + V2 humans) and Spanish AI sentence pools
    ns = pd.read_parquet(T / "f006_1_1/datasets/new_sources_raw.parquet")
    ns = ns[ns["dataset"].isin(["cowsl2h", "academic_abstracts_es", "scielo_es", "spanish_billion_words"])]
    ns["text_hash"] = ns["text"].map(normalized_text_hash)
    v2_hashes = set(idx["text_hash"].dropna())
    ns = ns[~ns["text_hash"].isin(v2_hashes)].drop_duplicates("text_hash")
    tr_new = set(extra["id"])
    f0611_val = set(pd.read_parquet(T / "f006_1_1/datasets/f006_1_1_validation.parquet", columns=["id"])["id"])
    ns["side"] = np.where(ns["id"].isin(tr_new), "TRAIN", np.where(ns["id"].isin(hold_ids), "NONE", "POOL"))
    pool = ns["side"] == "POOL"
    ns.loc[pool, "side"] = np.where([h(g) < 0.4 for g in ns.loc[pool, "group_id"]], "VALIDATION", "HOLDOUT")
    ns.loc[ns["id"].isin(f0611_val) & (ns["side"] == "HOLDOUT"), "side"] = "VALIDATION"
    ns.loc[ns["group_id"].isin(train_groups) & (ns["side"] != "TRAIN"), "side"] = "NONE"
    ns = ns[ns["side"] != "NONE"]
    hum = []
    for side, g in ns.groupby("side"):
        g = g.sample(min(len(g), CAPS[side]["HUMAN"] + CAPS[side]["ES_SPLICE"] + CAPS[side]["HARD_NEG"]), random_state=SEED)
        for r in g.to_dict("records"):
            base = {"id": r["id"], "dataset": r["dataset"], "language": "es", "domain": r.get("domain") or "academic", "fine_label": "HUMAN",
                    "generator_family": "none", "group_id": r["group_id"], "parent_id": None, "side": side, "split": "f0611_new", "subset": "human_es"}
            hum += to_units(base, r["text"], [], "HUMAN", max_units=2)
    v2h = idx[(idx["fine_label"] == "HUMAN") & idx["language"].isin(["en", "es"]) & ~idx["span_labels_present"].fillna(False).astype(bool)].copy()
    v2h["side"] = v2h.apply(side_v2, axis=1)
    v2h = v2h[v2h["side"] != "NONE"]
    v2h = pd.concat([g.sample(min(len(g), CAPS[s]["HUMAN"] // 2), random_state=SEED, weights=np.where(g["domain"] == "academic", 3.0, 1.0))
                     for s, g in v2h.groupby("side")])
    v2h = v2h.merge(master_texts({s: set(g["id"]) for s, g in v2h.groupby("split")}), on="id", how="left")
    for r in v2h[v2h["text_original"].notna()].to_dict("records"):
        base = {k: r[k] for k in ("id", "dataset", "language", "domain", "fine_label", "generator_family", "group_id", "parent_id", "side", "split")}
        base["subset"] = "human_v2"
        hum += to_units(base, r["text_original"], [], "HUMAN", max_units=1)
    hum = pd.DataFrame(hum)
    hn = hum["text"].str.contains(BOILER)
    hum.loc[hn, "kind"], hum.loc[hn, "subset"] = "HARD_NEG", "boilerplate"
    log(f"HUMAN units {len(hum):,} (hard negatives {int(hn.sum()):,})")

    esai = idx[(idx["language"] == "es") & idx["fine_label"].isin(["AI_GENERATED"])].copy()
    esai["side"] = esai.apply(side_v2, axis=1)
    esai = esai[esai["side"] != "NONE"]
    esai = pd.concat([g.sample(min(len(g), 20000), random_state=SEED) for _, g in esai.groupby("side")])
    esai = esai.merge(master_texts({s: set(g["id"]) for s, g in esai.groupby("split")}), on="id", how="left")
    ai_pool = {s: g["text_original"].dropna().tolist() for s, g in esai.groupby("side")}
    ai_groups = {s: set(g["group_id"]) for s, g in esai.groupby("side")}
    spl = []
    for side in ("TRAIN", "VALIDATION", "HOLDOUT"):
        srng = random.Random(f"{SEED}:splice:{side}")
        cands = hum[(hum["side"] == side) & (hum["language"] == "es") & (hum["kind"] == "HUMAN")].sample(frac=1.0, random_state=SEED).to_dict("records")
        used = set()
        for r in cands:
            if len(spl) and sum(1 for x in spl if x["side"] == side) >= CAPS[side]["ES_SPLICE"]:
                break
            s_ = splice(r, ai_pool.get(side, []), srng) if ai_pool.get(side) else None
            if s_:
                spl.append(s_)
                used.add(r["unit_id"])
        hum = hum[~hum["unit_id"].isin(used)]  # a human paragraph is either a negative or a splice host, never both
    log(f"ES_SPLICE units {len(spl):,}")

    allu = pd.concat([pd.DataFrame(units), hum, pd.DataFrame(spl)], ignore_index=True)
    for side in ("TRAIN", "VALIDATION", "HOLDOUT"):
        for kind in ("REFERENCE", "METADATA"):
            allu = pd.concat([allu, pd.DataFrame(synthetic(kind, CAPS[side][kind], side)).assign(side=side, split="synthetic")], ignore_index=True)
    # caps per side/kind
    allu = pd.concat([g.sample(min(len(g), CAPS[s].get(k, len(g))), random_state=SEED) for (s, k), g in allu.groupby(["side", "kind"])], ignore_index=True)
    allu["text_hash"] = allu["text"].map(normalized_text_hash)
    allu["lineage"] = allu["parent_id"].fillna(allu["id"]).astype(str)
    # one side per group / document / lineage: TRAIN wins over evaluation, HOLDOUT wins over VALIDATION
    rank = {"TRAIN": 0, "HOLDOUT": 1, "VALIDATION": 2}
    for key in ("group_id", "id", "lineage"):
        k = allu[key].astype(str)
        best = allu.assign(_k=k, _r=allu["side"].map(rank)).groupby("_k")["_r"].min()
        keep = allu["side"].map(rank).values == k.map(best).values
        if (~keep).any():
            log(f"dropping {int((~keep).sum()):,} units whose {key} also sits on a stronger side")
        allu = allu[keep].reset_index(drop=True)

    # ---------------- leakage gates
    tr, va, ho = (allu[allu["side"] == s].reset_index(drop=True) for s in ("TRAIN", "VALIDATION", "HOLDOUT"))
    for _ in range(20):
        drop = near_dup_members(pd.concat([va, ho]).rename(columns={"text": "text_original"}), tr.rename(columns={"text": "text_original"}))
        if not drop:
            break
        log(f"dropping {len(drop)} TRAIN units near-duplicate to evaluation units")
        tr = tr.drop(index=sorted(drop)).reset_index(drop=True)
    for _ in range(20):
        drop = near_dup_members(ho.rename(columns={"text": "text_original"}), va.rename(columns={"text": "text_original"}))
        if not drop:
            break
        log(f"dropping {len(drop)} VALIDATION units near-duplicate to holdout units")
        va = va.drop(index=sorted(drop)).reset_index(drop=True)
    ex = set(tr["text_hash"]) & set(ho["text_hash"]) | set(tr["text_hash"]) & set(va["text_hash"])
    if ex:
        va, ho = va[~va["text_hash"].isin(ex)], ho[~ho["text_hash"].isin(ex)]
    va = va[~va["text_hash"].isin(set(ho["text_hash"]))]

    def inter(a, b, col):
        return len(set(a[col].dropna().astype(str)) & set(b[col].dropna().astype(str)))

    def realgroups(f):
        return f[~f["dataset"].astype(str).str.startswith("synthetic")]

    leak = {"exact": {"validation_train": inter(va, tr, "text_hash"), "holdout_train": inter(ho, tr, "text_hash"), "validation_holdout": inter(va, ho, "text_hash")},
            "near_duplicate": {"eval_train": len(near_dup_members(pd.concat([va, ho]).rename(columns={"text": "text_original"}), tr.rename(columns={"text": "text_original"}))),
                               "validation_holdout": len(near_dup_members(ho.rename(columns={"text": "text_original"}), va.rename(columns={"text": "text_original"})))},
            "group": {"validation_train": inter(realgroups(va), realgroups(tr), "group_id"), "holdout_train": inter(realgroups(ho), realgroups(tr), "group_id"),
                      "validation_holdout": inter(realgroups(va), realgroups(ho), "group_id")},
            "document": {"validation_train": inter(va, tr, "id"), "holdout_train": inter(ho, tr, "id"), "validation_holdout": inter(va, ho, "id")},
            "lineage": {"validation_train": inter(va, tr, "lineage"), "holdout_train": inter(ho, tr, "lineage"), "validation_holdout": inter(va, ho, "lineage")},
            "parent_child": {"holdout_train": len((set(ho["parent_id"].dropna()) | set(ho["id"])) & (set(tr["parent_id"].dropna()) | set(tr["id"])))},
            "participant": {"cowsl2h_students": len({g for g in ho["group_id"] if str(g).startswith("cowsl2h:")} & set(tr["group_id"]))},
            "prompt": {"note": "Beemo prompt groups are not used in F006.1.2 (no exact spans); 0 by construction", "holdout_train": 0},
            "previous_holdouts_in_holdout": len(set(ho["id"]) & hold_ids)}
    flat = [v for d_ in leak.values() if isinstance(d_, dict) for v in d_.values() if isinstance(v, int)] + [leak["previous_holdouts_in_holdout"]]
    leak["result"] = "PASS" if all(v == 0 for v in flat) else "FAIL"
    log("leakage: " + json.dumps(leak))
    if leak["result"] != "PASS":
        write_json(D / "reports" / "leakage_report.json", leak)
        raise SystemExit("ABORT: leakage")

    def summary(f):
        return {"units": int(len(f)), "groups": int(f["group_id"].nunique()), "by_kind": f["kind"].value_counts().to_dict(),
                "by_subset": f["subset"].value_counts().to_dict(), "by_language": f["language"].value_counts().to_dict(),
                "by_domain": f["domain"].value_counts().to_dict(), "span_units": int((f["n_spans"] > 0).sum()), "gold_spans": int(f["n_spans"].sum()),
                "by_dataset": f["dataset"].value_counts().to_dict(), "generators": f.loc[f["n_spans"] > 0, "generator_family"].value_counts().to_dict()}

    ds = D / "datasets"
    names = {"TRAIN": "f006_1_2_span_train", "VALIDATION": "f006_1_2_span_validation", "HOLDOUT": "f006_1_2_span_final_holdout"}
    for side, f in (("TRAIN", tr), ("VALIDATION", va), ("HOLDOUT", ho)):
        f.to_parquet(ds / f"{names[side]}.parquet", index=False)
    commit = __import__("subprocess").run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=REPO).stdout.strip()
    created = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest = {"name": "F006_1_2_DATASET_MANIFEST", "created_at": created, "seed": SEED, "source_commit": commit,
                "normalization": "NFC per unit with char map; whitespace / line breaks / zero-width / homoglyphs preserved; spans re-projected",
                "unit": "paragraph-sized target (blank-line blocks, short blocks merged, >1800 chars cut at sentence ends)",
                "sources": {"opai_bench": "V2 exact AI spans (EN)", "het_ai_spans": "Heterogeneous AI Spans (single canonical view, V2 import)",
                            "es_splice": "Spanish human paragraphs + Spanish AI sentences, same side, exact spans by construction",
                            "human_es": "COWSL2H, academic abstracts ES, SciELO, SBW (F006.1.1 normalised)", "human_v2": "V2 human rows (EN/ES, academic x3)",
                            "synthetic_reference / synthetic_metadata": "fake names / DOIs, target = no span"},
                "not_used": {"AIUD-SPAN v2": "BLOCKED_ACCESS (gated, no token with access)", "SemEval-2024 Task 8 C": "UNAVAILABLE (repo needs credentials)",
                             "GRADTEX": "no exact span offsets in the release (MIXED completions without boundary) -> not a span source",
                             "Beemo": "edits without char-level alignment -> not a span source", "CEDEL2": "MANUAL_ACCESS_REQUIRED"},
                "unseen_generator_families_holdout": sorted(set(ho.loc[ho["subset"] == "unseen_generator", "generator_family"].dropna())),
                "train": summary(tr), "validation": summary(va), "holdout": summary(ho), "leakage": leak}
    lockobj = {"name": "F006_1_2_HOLDOUT_LOCK", "LOCKED": True, "lockedAt": created, "source_commit": commit,
               "holdout_file_sha256": sha256_file(ds / f"{names['HOLDOUT']}.parquet"), "validation_file_sha256": sha256_file(ds / f"{names['VALIDATION']}.parquet"),
               "train_file_sha256": sha256_file(ds / f"{names['TRAIN']}.parquet"), "holdout_unit_ids_sha256": sha256_ids(ho["unit_id"]),
               "holdout_group_ids_sha256": sha256_ids(ho["group_id"].astype(str).drop_duplicates()), "split_hash": hashlib.sha256(
                   (sha256_ids(tr["unit_id"]) + sha256_ids(va["unit_id"]) + sha256_ids(ho["unit_id"])).encode()).hexdigest(),
               "rule": "never used for training / selection / thresholds / abstention; evaluated ONCE after F006_1_2_MODEL_LOCK"}
    write_json(D / "manifests" / "F006_1_2_DATASET_MANIFEST.json", manifest)
    write_json(D / "reports" / "leakage_report.json", leak)
    write_json(lock, lockobj)
    out = REPO / "reports" / "f006_1_2"
    write_json(out / "dataset_manifest.json", manifest)
    write_json(out / "leakage_report.json", leak)
    write_json(out / "holdout_lock.json", lockobj)
    log(f"LOCKED F006_1_2 span holdout {len(ho):,} units; validation {len(va):,}; train {len(tr):,} in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
