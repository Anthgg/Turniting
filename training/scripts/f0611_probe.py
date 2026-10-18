"""F006.1.1 / F008: probe every requested source (file listings / HTTP HEAD only, no bulk download)."""

from __future__ import annotations

import json
import os
import sys
import urllib.request

HF = {
    "spanish_billion_words": "crscardellino/spanish_billion_words",
    "academic_abstracts_es": "Flaglab/academic-knowledge-abstracts-es",
    "scielo": "bigbio/scielo",
    "aiud_span_v2": "twsj/aiud_span_data_v2",
    "heterogeneous_ai_spans": "open-text-detector/heterogeneous-ai-spans",
    "gradtex": "elisabeth-pl-pl/GRADTEX",
    "beemo": "toloka/beemo",
    "mmarco_es_train": "irds/mmarco_v2_es_train",
    "mmarco_es": "irds/mmarco_v2_es",
    "miracl_corpus": "miracl/miracl-corpus",
}
HF_MODELS = {"bge_m3": "BAAI/bge-m3", "bge_reranker_v2_m3": "BAAI/bge-reranker-v2-m3", "e5_large_instruct": "intfloat/multilingual-e5-large-instruct"}
GITHUB = {"cowsl2h": "ucdaviscl/cowsl2h", "beemo_github": "Toloka/beemo", "semeval2024_task8": "mbzuai-nlp/SemEval2024-task8",
          "flagembedding": "FlagOpen/FlagEmbedding", "paws": "google-research-datasets/paws", "pan_code": "pan-webis-de/pan-code"}
WEB = {"cedel2": "https://cedel2.learnercorpora.com/", "pan11_zenodo": "https://zenodo.org/api/records/3250095",
       "pan25_zenodo_search": "https://zenodo.org/api/records?q=%22generative%20plagiarism%20detection%22%20pan%202025&size=5"}


def http(url, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "turniting-research/f0611"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, r.read(300000) if method == "GET" else b""


def main() -> int:
    from huggingface_hub import HfApi

    api, tok, out = HfApi(), os.environ.get("HF_TOKEN") or None, {"hf_token_available": bool(os.environ.get("HF_TOKEN"))}
    for k, repo in HF.items():
        try:
            info = api.dataset_info(repo, token=tok)
            files = [s.rfilename for s in (info.siblings or [])]
            out[k] = {"repo": repo, "status": "LISTED", "gated": str(getattr(info, "gated", False)), "license": (info.card_data or {}).get("license") if info.card_data else None,
                      "n_files": len(files), "files": files[:25], "sha": info.sha}
        except Exception as e:
            out[k] = {"repo": repo, "status": "BLOCKED_ACCESS" if "Gated" in type(e).__name__ or "401" in str(e) or "403" in str(e) else "ERROR", "error": type(e).__name__}
    for k, repo in HF_MODELS.items():
        try:
            info = api.model_info(repo, token=tok)
            out[k] = {"repo": repo, "status": "AVAILABLE", "license": (info.card_data or {}).get("license") if info.card_data else None, "sha": info.sha}
        except Exception as e:
            out[k] = {"repo": repo, "status": "ERROR", "error": type(e).__name__}
    for k, repo in GITHUB.items():
        try:
            st, body = http(f"https://api.github.com/repos/{repo}")
            meta = json.loads(body)
            out[k] = {"repo": repo, "status": "AVAILABLE", "license": (meta.get("license") or {}).get("spdx_id"), "default_branch": meta.get("default_branch"),
                      "size_kb": meta.get("size"), "pushed_at": meta.get("pushed_at")}
        except Exception as e:
            out[k] = {"repo": repo, "status": "ERROR", "error": f"{type(e).__name__} {str(e)[:80]}"}
    for k, url in WEB.items():
        try:
            st, body = http(url)
            txt = body.decode("utf-8", "ignore")
            out[k] = {"url": url, "status": st, "snippet": txt[:600] if not url.startswith("https://zenodo.org/api") else None,
                      "zenodo": json.loads(txt) if url.startswith("https://zenodo.org/api") and txt.strip().startswith("{") else None}
        except Exception as e:
            out[k] = {"url": url, "status": "ERROR", "error": f"{type(e).__name__} {str(e)[:120]}"}
    path = sys.argv[1] if len(sys.argv) > 1 else "probe.json"
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1, default=str)
    for k, v in out.items():
        if isinstance(v, dict):
            z = v.get("zenodo") or {}
            extra = ""
            if z:
                hits = z.get("hits", {}).get("hits") if "hits" in z else None
                extra = f" zenodo: {z.get('metadata', {}).get('title')} access={z.get('metadata', {}).get('access_right')} files={len(z.get('files', []))}" if not hits else \
                    " hits: " + "; ".join(f"{h['id']} {h['metadata']['title'][:60]} [{h['metadata'].get('access_right')}]" for h in hits)
            print(k, v.get("status"), v.get("license"), v.get("gated", ""), (v.get("files") or [])[:6], extra)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
