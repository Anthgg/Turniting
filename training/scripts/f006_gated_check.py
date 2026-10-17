"""F006: check access to the gated / restricted datasets (no download, no secret written anywhere).

    HF_TOKEN comes only from Colab Secrets (os.environ inside the runtime). Status per dataset:
    GRANTED | PENDING_OR_BLOCKED (gated, token has no access) | NO_TOKEN | RESTRICTED (Zenodo restricted files)
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

GATED_HF = {"MGTPD": "1024m/MGTPD-Public", "EDITLENS": "pangram/editlens_iclr"}
ZENODO = {"MULTISOCIAL": "13846152"}


def hf_status(repo: str, token: str | None) -> dict:
    from huggingface_hub import HfApi
    from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError

    if not token:
        return {"status": "NO_TOKEN", "repo": repo}
    try:
        files = HfApi().list_repo_files(repo, repo_type="dataset", token=token)
        # listing can work on gated repos too; the access test is a HEAD on a data file
        target = next((f for f in files if f.lower().endswith((".csv", ".parquet"))), files[0])
        url = f"https://huggingface.co/datasets/{repo}/resolve/main/{target}"
        req = urllib.request.Request(url, method="HEAD", headers={"Authorization": f"Bearer {token}"})
        try:
            urllib.request.urlopen(req, timeout=60)
            return {"status": "GRANTED", "repo": repo, "files": len(files)}
        except urllib.error.HTTPError as e:
            return {"status": "PENDING_OR_BLOCKED", "repo": repo, "http": e.code}
    except GatedRepoError:
        return {"status": "PENDING_OR_BLOCKED", "repo": repo}
    except RepositoryNotFoundError:
        return {"status": "NOT_FOUND", "repo": repo}
    except Exception as e:  # network etc.
        return {"status": "ERROR", "repo": repo, "error": type(e).__name__}


def zenodo_status(record: str) -> dict:
    try:
        meta = json.loads(urllib.request.urlopen(f"https://zenodo.org/api/records/{record}", timeout=60).read())
        access = meta.get("access", {}).get("files") or meta.get("metadata", {}).get("access_right")
        return {"status": "RESTRICTED" if str(access).lower() != "public" and str(access).lower() != "open" else "GRANTED",
                "record": record, "access": access}
    except Exception as e:
        return {"status": "ERROR", "record": record, "error": type(e).__name__}


def main() -> int:
    token = os.environ.get("HF_TOKEN") or None
    out = {"checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "hf_token_available": bool(token)}
    for k, repo in GATED_HF.items():
        out[k] = hf_status(repo, token)
    for k, rec in ZENODO.items():
        out[k] = zenodo_status(rec)
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("gated_status.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
