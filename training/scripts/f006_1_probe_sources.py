"""F006.1: probe candidate public Spanish human sources (official HF repos), no download beyond file listings."""

from __future__ import annotations

import json
import os

from huggingface_hub import HfApi

CANDIDATES = {
    "xlsum_spanish": "csebuetnlp/xlsum",
    "mlsum": "reciTAL/mlsum",
    "mlsum_alt": "mlsum",
    "cc_news_es": "LeoCordoba/CC-NEWS-ES",
    "wikipedia": "wikimedia/wikipedia",
    "large_spanish_corpus": "josecannete/large_spanish_corpus",
    "spanish_ted": "PlanTL-GOB-ES/ted_talks_es",
    "sqac": "PlanTL-GOB-ES/SQAC",
    "mldoc_es": "pmc/open_access",
}


def main() -> int:
    api = HfApi()
    tok = os.environ.get("HF_TOKEN") or None
    out = {}
    for k, repo in CANDIDATES.items():
        try:
            info = api.dataset_info(repo, token=tok, files_metadata=False)
            files = [s.rfilename for s in (info.siblings or [])]
            es = [f for f in files if "spanish" in f.lower() or "/es" in f.lower() or ".es" in f.lower() or "es/" in f.lower()][:15]
            out[k] = {"repo": repo, "gated": bool(getattr(info, "gated", False)), "license": (info.card_data or {}).get("license") if info.card_data else None,
                      "n_files": len(files), "spanish_files": es, "last_modified": str(info.last_modified)}
        except Exception as e:
            out[k] = {"repo": repo, "error": type(e).__name__}
    print(json.dumps(out, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
