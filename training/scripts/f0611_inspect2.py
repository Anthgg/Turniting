"""F006.1.1: second inspection pass (COWSL2H layout, HAS data files, GRADTEX / Beemo / abstracts columns)."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pandas as pd

RAW = Path("/content/f0611_raw")


def main() -> int:
    from huggingface_hub import HfApi, hf_hub_download

    d = RAW / "cowsl2h"
    files = [p for p in d.rglob("*.txt") if ".git" not in p.parts]
    tops = Counter(p.relative_to(d).parts[0] for p in files)
    print("COWSL2H top dirs:", tops.most_common(15))
    print("COWSL2H sample paths:", [str(p.relative_to(d)) for p in files[100:112]])
    one = files[150]
    print("COWSL2H sample text:", repr(one.read_text(errors="ignore")[:300]))
    csv = d / "longitudinal_essay_data.csv"
    if csv.exists():
        df = pd.read_csv(csv, nrows=5)
        print("longitudinal csv columns:", list(df.columns))
    files = HfApi().list_repo_files("open-text-detector/heterogeneous-ai-spans", repo_type="dataset")
    data = [f for f in files if not f.startswith(("audits", "assets")) and f.endswith((".parquet", ".jsonl", ".jsonl.gz", ".json", ".csv"))]
    print("HAS data files:", len(data), data[:30])
    for repo, f in (("elisabeth-pl-pl/GRADTEX", "train.parquet"), ("toloka/beemo", "data/train-00000-of-00001.parquet"),
                    ("Flaglab/academic-knowledge-abstracts-es", "data/train-00000-of-00001.parquet")):
        df = pd.read_parquet(hf_hub_download(repo, f, repo_type="dataset"))
        print(repo, df.shape, list(df.columns)[:30])
        for c in ("scenario", "scenario_family", "model_family", "label", "category", "model", "facultad", "faculty", "year"):
            if c in df.columns:
                print("   ", c, df[c].astype(str).value_counts().head(8).to_dict())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
