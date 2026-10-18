"""F006.1: Spanish human rows by split / dataset / original V1 split / raw domain (metadata only)."""
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as d

r = []
for s in ["train", "validation", "test", "unseen_domain_test"]:
    t = d.dataset(f"/content/f006work/master_v2/{s}", format="parquet").to_table(
        columns=["dataset", "raw_domain", "subset", "v1_split", "origin"],
        filter=(pc.field("language") == "es") & (pc.field("fine_label") == "HUMAN")).to_pandas()
    t["split"] = s
    r.append(t)
df = pd.concat(r)
print(df.groupby(["split", "dataset", "v1_split", "raw_domain"], dropna=False).size().to_string())
