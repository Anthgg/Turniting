"""F006.1.1: inspect source formats (small reads only)."""

from __future__ import annotations

import os
import re
import subprocess
import urllib.request
from pathlib import Path

RAW = Path("/content/f0611_raw")
RAW.mkdir(parents=True, exist_ok=True)


def get(url, n=200000):
    req = urllib.request.Request(url, headers={"User-Agent": "turniting-research/f0611"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(n).decode("utf-8", "ignore")


def main() -> int:
    from huggingface_hub import HfApi, hf_hub_download

    for repo in ("ucdaviscl/cowsl2h", "mbzuai-nlp/SemEval2024-task8"):
        d = RAW / repo.split("/")[1]
        if not d.exists():
            r = subprocess.run(["git", "clone", "-q", "--depth", "1", f"https://github.com/{repo}.git", str(d)], capture_output=True, text=True)
            print(repo, "clone rc", r.returncode, r.stderr[:200])
        if d.exists():
            files = [p for p in d.rglob("*") if p.is_file() and ".git/" not in str(p)]
            print(repo, len(files), "files; ext", sorted({p.suffix for p in files})[:15])
            print("  sample:", [str(p.relative_to(d)) for p in files[:12]])
            readme = next((p for p in files if p.name.lower().startswith("readme")), None)
            if readme:
                txt = readme.read_text(errors="ignore")
                print("  readme links:", re.findall(r"https?://[^\s)>\]]+", txt)[:15])
    for repo, f in (("crscardellino/spanish_billion_words", "spanish_billion_words.py"), ("bigbio/scielo", "scielo.py")):
        p = hf_hub_download(repo, f, repo_type="dataset")
        txt = Path(p).read_text(errors="ignore")
        print(repo, "urls:", re.findall(r"https?://[^\s\"')]+", txt)[:10])
    files = HfApi().list_repo_files("open-text-detector/heterogeneous-ai-spans", repo_type="dataset")
    print("HAS files:", [f for f in files if f.endswith((".parquet", ".jsonl", ".json", ".csv"))][:40])
    try:
        html = get("https://cedel2.learnercorpora.com/")
        print("CEDEL2 links:", sorted(set(re.findall(r'href="([^"]+)"', html)))[:40])
        for path in ("/download", "/downloads", "/search"):
            try:
                h = get("https://cedel2.learnercorpora.com" + path, 20000)
                print("CEDEL2", path, "->", re.sub(r"\s+", " ", re.sub("<[^>]+>", " ", h))[:400])
            except Exception as e:
                print("CEDEL2", path, type(e).__name__, str(e)[:80])
    except Exception as e:
        print("CEDEL2 error", e)
    print("disk", os.popen("df -h /content | tail -1").read())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
