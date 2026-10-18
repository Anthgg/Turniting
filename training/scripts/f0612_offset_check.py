"""F006.1.2: offset round-trip validation with the real mDeBERTa tokenizer (OFFSETS_VALIDATED).

    python scripts/f0612_offset_check.py [--tokenizer <dir>]

For each case: original text + gold char spans -> NFC map -> token labels -> spans rebuilt from the gold token labels
(predict_spans on 0/1 probabilities) -> mapped back to the original text. A case passes when every rebuilt span covers
its gold span up to whitespace / sub-token boundary slack (<= 1 char each side) and no span leaks outside the target.
Also checks contextual mode: offsets are computed on the target paragraph only, never on left/right context.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0612_spans import nfc_with_map, predict_spans, project_spans, token_labels  # noqa: E402

CASES = [
    ("acentos", "La educación pública en el Perú enfrentó múltiples desafíos. Esta oración fue generada por un modelo. Fin.", ["Esta oración fue generada por un modelo."]),
    ("ene", "El niño soñó con la montaña. La compañía señaló avances importantes en el año. Así terminó.", ["La compañía señaló avances importantes en el año."]),
    ("comillas", "Ella dijo «hola» y luego “adiós”. El texto entre comillas ‘simples’ también cuenta aquí. Listo.", ["El texto entre comillas ‘simples’ también cuenta aquí."]),
    ("decomposed_unicode", "Café con leche. Una frase con acentos descompuestos: educación y niño. Final.", ["Una frase con acentos descompuestos: educación y niño."]),
    ("saltos", "Primera línea humana.\nSegunda línea generada por IA con detalle.\n\nTercera línea humana.", ["Segunda línea generada por IA con detalle."]),
    ("puntuacion", "¿Qué pasó? ¡Nada! Sin embargo, el análisis (véase la tabla 2) mostró diferencias; claras. Ok.", ["Sin embargo, el análisis (véase la tabla 2) mostró diferencias; claras."]),
    ("emoji", "Me gustó mucho 😀 la clase. Esta parte incluye un emoji 🚀 dentro del tramo. Gracias.", ["Esta parte incluye un emoji 🚀 dentro del tramo."]),
    ("zero_width", "Texto hu​mano normal. Tramo con zero​width inser​tado aquí. Cierre.", ["Tramo con zero​width inser​tado aquí."]),
    ("homoglyph", "Texto humano. Trаmo con homóglіfos cirílicos dentro. Cierre.", ["Trаmo con homóglіfos cirílicos dentro."]),
    ("multiple", "Uno humano. Dos generado aquí. Tres humano. Cuatro generado también. Cinco humano.", ["Dos generado aquí.", "Cuatro generado también."]),
]


def main() -> int:
    from transformers import AutoTokenizer

    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", default="/content/drive/MyDrive/turniting/f006_1/models/experimental_f006_1/backbone")
    a = ap.parse_args()
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    results, ok_all = [], True
    for name, text, spans_txt in CASES:
        gold = [[text.index(s), text.index(s) + len(s)] for s in spans_txt]
        nfc, src = nfc_with_map(text)
        g = project_spans(gold, src)
        enc = tok(nfc, return_offsets_mapping=True, add_special_tokens=True)
        offs = [tuple(o) for o in enc["offset_mapping"]]
        lab = token_labels(offs, g, len(nfc))
        prob = np.where(lab >= 1, 1.0, 0.0)
        pred = predict_spans(prob, offs, {"tau": 0.5, "gap": 0, "min_tokens": 1, "abstain": 0.0})
        rebuilt = [[int(src[p["startChar"]]), int(src[p["endChar"]])] for p in pred]
        ok = len(rebuilt) == len(gold) and all(abs(r[0] - q[0]) <= 1 and abs(r[1] - q[1]) <= 1 for r, q in zip(rebuilt, gold))
        # contextual mode: score target inside context, offsets must be relative to target
        left, right = "Contexto previo del documento. ", " Contexto posterior."
        ctx = left + nfc + right
        enc2 = tok(ctx, return_offsets_mapping=True, add_special_tokens=True)
        offs2 = [(s - len(left), e - len(left)) if s >= len(left) and e <= len(left) + len(nfc) else (0, 0) for s, e in enc2["offset_mapping"]]
        lab2 = token_labels(offs2, g, len(nfc))
        pred2 = predict_spans(np.where(lab2 >= 1, 1.0, 0.0), offs2, {"tau": 0.5, "gap": 0, "min_tokens": 1, "abstain": 0.0})
        ctx_ok = all(0 <= p["startChar"] < p["endChar"] <= len(nfc) for p in pred2) and len(pred2) == len(gold)
        ok_all &= ok and ctx_ok
        results.append({"case": name, "gold": gold, "rebuilt": rebuilt, "round_trip_ok": ok, "context_target_only_ok": ctx_ok,
                        "gold_text": [text[s:e] for s, e in gold], "rebuilt_text": [text[s:e] for s, e in rebuilt]})
    out = {"tokenizer": a.tokenizer, "cases": results, "OFFSETS_VALIDATED": bool(ok_all)}
    p = Path(__file__).resolve().parents[1] / "reports" / "f006_1_2" / "offset_validation.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    for r in results:
        print(f"{r['case']:<20} round_trip={r['round_trip_ok']} context={r['context_target_only_ok']} {r['rebuilt_text']}")
    print("OFFSETS_VALIDATED", ok_all)
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
