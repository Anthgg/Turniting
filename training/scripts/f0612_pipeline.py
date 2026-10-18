"""F006.1.2 orchestrator (resumable; .done markers on Drive). Never runs while another GPU training is active.

    nohup python scripts/f0612_pipeline.py > /content/f0612_pipeline.out 2>&1 &

data -> wait for F006.1.1 final -> decision (F006.1.1 span F1 >= 0.86 -> SPAN_SERVING_READINESS_EVAL first) ->
stage-A ablations (sequential choices: parent, label scheme, loss ratio, token loss, positive weight, replay) ->
summary -> full run -> lock -> single final evaluation.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f006_lib import log, write_json  # noqa: E402

T = Path("/content/drive/MyDrive/turniting")
D = T / "f006_1_2"
LOG = D / "logs"
PY = [sys.executable, "-W", "ignore"]
ABL_WINDOWS = 120000
FULL_WINDOWS = 320000


def done(step):
    return (LOG / f"{step}.done").exists()


def mark(step, info=None):
    write_json(LOG / f"{step}.done", {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **(info or {})})
    log(f"=== STEP {step} DONE")


def run(cmd):
    log("$ " + " ".join(map(str, cmd)))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise SystemExit(f"ABORT: {cmd[2:5]} exited {r.returncode}")


def gpu_training_active() -> bool:
    out = subprocess.run(["ps", "aux"], capture_output=True, text=True).stdout
    return any(k in out for k in ("f006_train.py", "f0611_lockeval.py final"))


def result(run_name):
    p = D / "runs" / run_name / "result.json"
    return json.loads(p.read_text()) if p.exists() else None


def train(name, **kw):
    if result(name):
        return result(name)
    args = {"parent": "F006_1_1", "scheme": "binary", "alpha": 0.4, "beta": 0.6, "tok-loss": "weighted", "pos-weight": 2.0, "windows": ABL_WINDOWS, "replay-frac": 0.25}
    args.update({k.replace("_", "-"): v for k, v in kw.items()})
    cmd = PY + ["scripts/f0612_train.py", "train", "--run", name]
    for k, v in args.items():
        cmd += [f"--{k}", str(v)]
    run(cmd)
    return result(name)


def best(names):
    rs = [result(n) for n in names if result(n)]
    ok = [r for r in rs if r["paragraph_regression_ok"]] or rs
    return max(ok, key=lambda r: r["selection_score"])


def main() -> int:
    LOG.mkdir(parents=True, exist_ok=True)
    if not done("data"):
        run(PY + ["scripts/f0612_data.py"])
        mark("data")
    # ---------------- dependency: F006.1.1 final report
    f11 = T / "f006_1_1" / "manifests" / "F006_1_1_FINAL_EVAL_DONE.json"
    while not f11.exists():
        log("waiting for the F006.1.1 final evaluation ...")
        time.sleep(300)
    while gpu_training_active():
        log("GPU busy with F006.1.1 work; waiting ...")
        time.sleep(120)
    if not done("decision"):
        rob = json.loads((T / "f006_1_1" / "reports" / "robustness.json").read_text())["span"].get("F006_1_1_MODEL", {})
        gates = json.loads((T / "f006_1_1" / "reports" / "gates.json").read_text())
        fin = json.loads((T / "f006_1_1" / "reports" / "final_holdout.json").read_text())["models"].get("F006_1_1_MODEL", {}).get("subsets", {})
        info = {"F006_1_1_STATUS": gates["status"], "F006_1_1_SPAN_TOKEN_F1": rob.get("token_f1"), "F006_1_1_SPAN_PRECISION": rob.get("token_precision"),
                "F006_1_1_SPAN_RECALL": rob.get("token_recall"), "F006_1_1_CHAR_F1": rob.get("char_f1"),
                "F006_1_1_MIXED_RECALL": (fin.get("mixed") or {}).get("recall"), "F006_1_1_OVERALL_FPR": (fin.get("all") or {}).get("fpr"),
                "F006_1_1_SPANISH_FPR": (fin.get("spanish") or {}).get("fpr"), "F006_1_1_UNSEEN_GENERATOR_FPR": (fin.get("unseen_generator") or {}).get("fpr")}
        span_ok = (rob.get("token_f1") or 0) >= 0.86 and (rob.get("token_precision") or 0) >= 0.80 and (rob.get("token_recall") or 0) >= 0.80
        info["rule"] = "F006.1.1 span F1 >= 0.86 with precision/recall >= 0.80 -> SPAN_SERVING_READINESS_EVAL before any training"
        info["readiness_required"] = span_ok
        if span_ok:
            run(PY + ["scripts/f0612_train.py", "readiness", "--model", "F006_1_1"])
            rd = json.loads((D / "reports" / "readiness_f006_1_1_locked.json").read_text())
            info["readiness_status"] = rd["status"]
            if rd["status"] == "NO_ADDITIONAL_TRAINING_REQUIRED":
                mark("decision", {**info, "ADDITIONAL_TRAINING_REQUIRED": False})
                log("NO_ADDITIONAL_TRAINING_REQUIRED")
                return 0
        mark("decision", {**info, "ADDITIONAL_TRAINING_REQUIRED": True})
    # ---------------- stage A (validation only)
    if not done("stage_a"):
        train("S1_p0611")
        train("S2_p061", parent="F006_1")
        P = best(["S1_p0611", "S2_p061"])["args"]["parent"]
        train("S3_bio", parent=P, scheme="bio")
        S = best(["S1_p0611" if P == "F006_1_1" else "S2_p061", "S3_bio"])["args"]["scheme"]
        base = "S3_bio" if S == "bio" else ("S1_p0611" if P == "F006_1_1" else "S2_p061")
        train("S4_a50", parent=P, scheme=S, alpha=0.5, beta=0.5)
        train("S5_a30", parent=P, scheme=S, alpha=0.3, beta=0.7)
        A = best([base, "S4_a50", "S5_a30"])["args"]
        train("S6_focal", parent=P, scheme=S, alpha=A["alpha"], beta=A["beta"], tok_loss="focal")
        train("S7_pw4", parent=P, scheme=S, alpha=A["alpha"], beta=A["beta"], pos_weight=4.0)
        B = best([base, "S4_a50", "S5_a30", "S6_focal", "S7_pw4"])["args"]
        train("S8_replay40", parent=P, scheme=S, alpha=B["alpha"], beta=B["beta"], tok_loss=B["tok_loss"], pos_weight=B["pos_weight"], replay_frac=0.40)
        run(PY + ["scripts/f0612_train.py", "summary"])
        mark("stage_a")
    if not done("full"):
        b = json.loads((D / "runs" / "BEST_ABLATION.json").read_text())
        r = result(b["run"])["args"]
        train("SFULL", parent=r["parent"], scheme=r["scheme"], alpha=r["alpha"], beta=r["beta"], tok_loss=r["tok_loss"], pos_weight=r["pos_weight"],
              replay_frac=r["replay_frac"], windows=FULL_WINDOWS)
        run(PY + ["scripts/f0612_train.py", "summary"])
        mark("full")
    if not done("lock"):
        run(PY + ["scripts/f0612_train.py", "lock", "--run", "SFULL"])
        mark("lock")
    if not done("final"):
        run(PY + ["scripts/f0612_train.py", "final"])
        mark("final")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
