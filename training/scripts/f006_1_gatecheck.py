"""F006.1 Stage-A validation gate (prints 1 when at least one ablation passes, else 0).

The pre-registered gate is: overall human FPR <= 0.05 AND Spanish human FPR <= 0.08 on F006_1 VALIDATION.
The ablation score is computed at a fixed proxy operating point (general-human FPR 0.04), where overall FPR can
land a little above 0.05 although both conditions are reachable with one threshold. This check applies the gate
literally: one global threshold set at overall human FPR = 0.05 (validation), then Spanish FPR must be <= 0.08.
Results go to <drive>/reports/ablation_gate_check.json.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import threshold_for_fpr, wilson, write_json  # noqa: E402

import os  # noqa: E402

D61 = Path(os.environ.get("F006_DRIVE", "/content/drive/MyDrive/turniting/f006_1"))
VAL = os.environ.get("F006_VAL", "f006_1_validation.parquet")
REPO = Path(__file__).resolve().parents[1]


def main() -> int:
    val = pd.read_parquet(D61 / "datasets" / VAL, columns=["id", "label", "language"]).set_index("id")
    out, any_ok = {}, False
    for p in sorted((D61 / "runs").glob("*/validation_doc_logits.parquet")):
        lg = pd.read_parquet(p).set_index("id").reindex(val.index)["logit"].values
        y, es = val["label"].values, (val["language"] == "es").values
        t = threshold_for_fpr(lg[y == 0], 0.05)
        k_es, n_es = int(((lg >= t) & (y == 0) & es).sum()), int(((y == 0) & es).sum())
        fpr_es = k_es / max(n_es, 1)
        ok = fpr_es <= 0.08
        any_ok |= ok
        out[p.parent.name] = {"threshold_logit": t, "overall_fpr": float(((lg >= t) & (y == 0)).sum() / max((y == 0).sum(), 1)),
                              "spanish_fpr": fpr_es, "spanish_fpr_ci95": wilson(k_es, n_es), "spanish_recall": float(((lg >= t) & (y == 1) & es).sum() / max(((y == 1) & es).sum(), 1)),
                              "passes": bool(ok)}
    rep = {"rule": __doc__.split("This check")[1].strip(), "runs": out, "any_pass": bool(any_ok)}
    write_json(D61 / "reports" / "ablation_gate_check.json", rep)
    write_json(REPO / "reports" / os.environ.get("F006_REPORT_DIR", "f006_1") / "ablation_gate_check.json", rep)
    print(int(any_ok))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
