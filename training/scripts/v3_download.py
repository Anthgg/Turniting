"""Download the new public sources of TURNITING_DATASET_V2 and write the download manifest.

    python scripts/v3_download.py --raw /content/raw_v2 [--only detectrl_x opai_bench ...]

V1 sources are NOT downloaded again (V2 reuses the V1 master parquet). Gated / restricted
sources are attempted with the read token in the HF_TOKEN environment variable (never printed
or written anywhere); without access they are recorded as BLOCKED_ACCESS and the run goes on.
Unified TELL is intentionally not downloaded (overlaps RAID/AuTex/MAGE/Ghostbuster).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import MANIFEST_DIR, sha256_file, utc_now, write_json  # noqa: E402

DETECTRL_BINARY = [f"Binary/binary_{s}_open.json" for s in (
    "general", "general_64", "general_128", "general_256", "general_512", "backtranslation",
    "character_deletion", "character_insertion", "character_substitution", "condensing", "decoder_paraphrasing",
    "encoder_paraphrasing", "expanding", "polishing", "seq2seq_paraphrasing", "zero_width_insertion")]

SOURCES = {
    "mgtbench2_academic": dict(
        kind="hf", repo="AITextDetect/AI_Polish_clean", allow=["Human/*/*.json", "*_new/*.json"],
        url="https://github.com/Y-L-LIU/MGTBench-2.0", license="UNDECLARED (benchmark code: see repo)",
        language=["en"], generators=["gpt-3.5", "moonshot", "llama3", "mixtral", "gpt-4o-mini"],
        domain="academic (STEM / Humanities / Social sciences)", priority="S+",
        notes="MGTBench 2.0 / MGT-Academic data (HF AITextDetect/AI_Polish_clean); loaded without the remote loading script"),
    "mgtpd": dict(
        kind="hf", repo="1024m/MGTPD-Public", allow=["*.csv", "README.md"], gated=True,
        url="https://huggingface.co/datasets/1024m/MGTPD-Public", license="CC-BY-NC-ND-4.0",
        language=["multilingual (23)"], generators=["multiple"], domain="multi", priority="S+",
        notes="gated: requires accepted terms + HF_TOKEN"),
    "detectrl_x": dict(
        kind="hf", repo="WUJUNCHAO/DetectRL-X", allow=["Ternary/trinary_general_open.json", *DETECTRL_BINARY],
        url="https://huggingface.co/datasets/WUJUNCHAO/DetectRL-X", license="MIT",
        language=["ar", "zh", "en", "fr", "de", "pt", "ru", "es"],
        generators=["deepseek-v3", "gemini-2.5-flash", "gpt-4o", "qwen-max"], domain="multi", priority="S+",
        notes="train split identical across strategy files: train from *general* only, other strategies test-only"),
    "opai_bench": dict(
        kind="hf", repo="OpAI-Bench1/OpAI-Bench", allow=["default/*/*.csv", "ablations/*/*.csv", "README.md"],
        url="https://huggingface.co/datasets/OpAI-Bench1/OpAI-Bench", license="Apache-2.0", language=["en"],
        generators=["gpt-5.4", "gpt-5.4-nano", "gemini-2.5-flash", "qwen3-8b"],
        domain="abstracts, essays, news, reports", priority="S+",
        notes="progressive human->AI editing v0..v8 with char/token/sentence labels"),
    "het_ai_spans": dict(
        kind="hf", repo="open-text-detector/heterogeneous-ai-spans",
        allow=["data/mixed/*.parquet", "data/human_controls/*.parquet", "LICENSE.md", "SHA256SUMS.txt", "README.md"],
        url="https://huggingface.co/datasets/open-text-detector/heterogeneous-ai-spans",
        license="mixed-source terms (see LICENSE.md; research use)", language=["en"],
        generators=["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "opus-3", "gpt-6.1-sol", "gpt-6-luna"],
        domain="fiction, reference, economic reports, ML papers", priority="S+",
        notes="default view only (layout_neutral views are the same samples and must not be combined)"),
    "academic_arxiv_gpt_gemini": dict(
        kind="hf", repo="mohamedmady/Academic-Text-arxiv-gpt-gemini", allow=["academic_text.parquet", "README.md"],
        url="https://huggingface.co/datasets/mohamedmady/Academic-Text-arxiv-gpt-gemini",
        license="MIT (generated); arXiv per-paper licences (human)", language=["en"],
        generators=["gpt-3.5-turbo", "gemini-2.0-flash"], domain="academic/STEM", priority="S+",
        notes="parquet is canonical; txt files skipped (no labels)"),
    "nigerian_academic": dict(
        kind="mendeley", dataset="mfyx7pxwws", version=1, url="https://data.mendeley.com/datasets/mfyx7pxwws/1",
        license="CC-BY-NC-4.0", language=["en"],
        generators=["gpt-4o", "gpt-4o-mini", "claude-sonnet", "gemini-2.5-flash", "grok-3-mini", "deepseek"],
        domain="academic (theses, dissertations, articles)", priority="A"),
    "aigtxt": dict(
        kind="mendeley", dataset="y9bj7734vf", version=1, url="https://data.mendeley.com/datasets/y9bj7734vf/1",
        license="CC-BY-4.0 (Mendeley default; verify)", language=["en"], generators=["chatgpt"],
        domain="scientific (10 areas)", priority="A"),
    "editlens": dict(
        kind="hf", repo="pangram/editlens_iclr", allow=["data/*.parquet", "README.md"], gated=True,
        url="https://huggingface.co/datasets/pangram/editlens_iclr", license="non-commercial (see card)",
        language=["en"], generators=["multiple"], domain="multi", priority="S",
        notes="gated: requires accepted terms + HF_TOKEN"),
    "gradtex": dict(
        kind="hf", repo="elisabeth-pl-pl/GRADTEX", allow=["*.parquet", "README.md"],
        url="https://huggingface.co/datasets/elisabeth-pl-pl/GRADTEX", license="CC-BY-4.0", language=["en"],
        generators=["qwen-3.5-27b", "gemma-4-31b", "gemma-4-e4b", "mistral-small-3.2", "claude-sonnet-4.6",
                    "gpt-5.4-mini", "gemini-3.5-flash"],
        domain="MAGE domains", priority="A", notes="built on MAGE: deduplicated against V1 MAGE"),
    "txd22": dict(
        kind="mendeley", dataset="prcjcggtjf", version=1, url="https://data.mendeley.com/datasets/prcjcggtjf/1",
        license="CC-BY-4.0 (Mendeley default; verify)", language=["en"], generators=["17 systems"],
        domain="30 academic/professional domains", priority="A"),
    "beemo": dict(
        kind="hf", repo="toloka/beemo", allow=["data/*.parquet", "README.md"],
        url="https://huggingface.co/datasets/toloka/beemo", license="MIT", language=["en"],
        generators=["10 open LLMs", "llama-3.1-70b (edits)", "gpt-4o (edits)"], domain="No Robots categories",
        priority="A"),
    "mdta": dict(
        kind="hf", repo="nsp909/MDTA", allow=["*.jsonl", "README.md"], url="https://huggingface.co/datasets/nsp909/MDTA",
        license="CC-BY-SA-4.0", language=["en"],
        generators=["llama-3.1-8b", "gemma-3-12b", "qwen2.5-vl-7b", "ministral-8b"], domain="HC3 domains",
        priority="A", notes="HC3 questions/humans: grouped by question_index, deduplicated against V1 HC3"),
    "outfox": dict(
        kind="github", repo="ryuryukke/OUTFOX", ref="main", url="https://github.com/ryuryukke/OUTFOX",
        license="Apache-2.0", language=["en"], generators=["gpt-3.5-turbo-0613", "text-davinci-003", "flan-t5-xxl"],
        domain="student essays", priority="A", notes="pickles read with a restricted unpickler (str/list/dict only)"),
    "coling2025_mgt_en": dict(
        kind="hf", repo="Jinyan1/COLING_2025_MGT_en", allow=["data/*.parquet", "README.md"],
        url="https://huggingface.co/datasets/Jinyan1/COLING_2025_MGT_en", license="UNDECLARED (aggregates M4GT/MAGE/...)",
        language=["en"], generators=["41 generators"], domain="multi", priority="B",
        notes="heavy overlap with V1 (M4/MAGE): strong dedup"),
    "openllmtext": dict(
        kind="hf", repo="TheItCrOw/OpenLLMText", allow=["data/*.parquet", "README.md"],
        url="https://huggingface.co/datasets/TheItCrOw/OpenLLMText", license="UNDECLARED", language=["en"],
        generators=["chatgpt", "palm", "llama", "gpt2"], domain="web (OpenWebText)", priority="B"),
    "seqxgpt": dict(
        kind="hf", repo="TheItCrOw/SeqXGPT", allow=["data/*.parquet", "README.md"],
        url="https://huggingface.co/datasets/TheItCrOw/SeqXGPT", license="UNDECLARED", language=["en"],
        generators=["gpt2", "gpt-neo", "gpt-j", "llama", "gpt-3"], domain="multi", priority="B",
        notes="HF mirror: document-level rows only (no sentence boundaries)"),
    "multisocial": dict(
        kind="zenodo", record="13846152", url="https://zenodo.org/records/13846152", license="restricted access",
        language=["22 languages incl. es"], generators=["7 LLMs"], domain="social media", priority="B",
        notes="files are restricted on Zenodo"),
    "ai_text_detection_benchmark_2026": dict(
        kind="hf", repo="textsightai/ai-text-detection-benchmark-2026", allow=["data/*.jsonl", "README.md"],
        url="https://huggingface.co/datasets/textsightai/ai-text-detection-benchmark-2026", license="CC-BY-SA-4.0 / CC-BY / PD",
        language=["en"], generators=["claude-opus-5", "claude-haiku-4-5", "gpt-4.1", "gpt-oss-120b", "qwen-3.8-27b"],
        domain="encyclopedic, biomedical academic", priority="EVAL", evaluation_only=True,
        notes="EXTERNAL_HOLDOUT_2026: never used for training, tuning or threshold selection"),
}
NOT_DOWNLOADED = {
    "unified_tell": "index only: overlaps RAID/AuTexTification/MAGE/Ghostbuster already in V1 (task rule 6)",
}


def _get(url: str, token: str | None = None, timeout: int = 120):
    headers = {"User-Agent": "turniting-research/3"}
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def download_url(url: str, dest: Path, retries: int = 4) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(retries):
        try:
            with _get(url, timeout=600) as r, open(dest.with_suffix(dest.suffix + ".part"), "wb") as fh:
                shutil.copyfileobj(r, fh, 8 * 1024 * 1024)
            os.replace(dest.with_suffix(dest.suffix + ".part"), dest)
            return
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def fetch_hf(name: str, src: dict, out: Path) -> list[Path]:
    from huggingface_hub import snapshot_download

    token = os.environ.get("HF_TOKEN") or None
    path = snapshot_download(repo_id=src["repo"], repo_type="dataset", allow_patterns=src["allow"],
                             local_dir=str(out), token=token, max_workers=16)
    return [p for p in Path(path).rglob("*") if p.is_file() and ".cache" not in p.parts]


def fetch_mendeley(name: str, src: dict, out: Path) -> list[Path]:
    api = f"https://data.mendeley.com/public-api/datasets/{src['dataset']}/files?folder_id=root&version={src['version']}"
    files = json.loads(_get(api).read())
    paths = []
    for f in files:
        dest = out / f["filename"]
        if not dest.exists():
            download_url(f["content_details"]["download_url"], dest)
        paths.append(dest)
    return paths


def fetch_github(name: str, src: dict, out: Path) -> list[Path]:
    zpath = out / f"{name}.zip"
    if not zpath.exists():
        download_url(f"https://codeload.github.com/{src['repo']}/zip/refs/heads/{src['ref']}", zpath)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(out)
    return [zpath]


def fetch_zenodo(name: str, src: dict, out: Path) -> list[Path]:
    meta = json.loads(_get(f"https://zenodo.org/api/records/{src['record']}").read())
    if meta.get("metadata", {}).get("access_right") != "open" or not meta.get("files"):
        raise PermissionError("restricted files")
    paths = []
    for f in meta["files"]:
        dest = out / f["key"]
        download_url(f["links"]["self"], dest)
        paths.append(dest)
    return paths


FETCH = {"hf": fetch_hf, "mendeley": fetch_mendeley, "github": fetch_github, "zenodo": fetch_zenodo}


def is_access_error(exc: Exception) -> bool:
    text = f"{type(exc).__name__} {exc}".lower()
    return any(k in text for k in ("gated", "401", "403", "restricted", "permission", "unauthorized", "forbidden",
                                   "access to dataset", "authenticated"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="/content/raw_v2")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--manifest", default=str(MANIFEST_DIR / "TURNITING_DATASET_V2_DOWNLOAD_MANIFEST.json"))
    ap.add_argument("--no-sha", action="store_true", help="skip per-file sha256 (large files)")
    args = ap.parse_args()
    raw = Path(args.raw)
    manifest_path = Path(args.manifest)
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"datasets": {}}
    entries = previous.get("datasets", {})
    for name, src in SOURCES.items():
        if args.only and name not in args.only:
            continue
        out = raw / name
        t0 = time.time()
        entry = {
            "name": name, "source": src["url"], "datasetId": src.get("repo") or src.get("dataset") or src.get("record"),
            "kind": src["kind"], "gated": bool(src.get("gated")), "license": src["license"],
            "language": src["language"], "generators": src["generators"], "domain": src["domain"],
            "priority": src["priority"], "evaluationOnly": bool(src.get("evaluation_only")),
            "trainEligible": not src.get("evaluation_only"), "notes": src.get("notes", ""),
        }
        try:
            files = FETCH[src["kind"]](name, src, out)
            files = [f for f in files if f.is_file()]
            entry.update(status="EVAL_ONLY" if src.get("evaluation_only") else "DOWNLOADED", downloaded=True,
                         bytes=int(sum(f.stat().st_size for f in files)),
                         files={str(f.relative_to(out)): {"bytes": f.stat().st_size,
                                                          "sha256": None if args.no_sha else sha256_file(f)}
                                for f in files})
        except Exception as exc:  # recorded, never fatal for the run
            blocked = is_access_error(exc)
            entry.update(status="BLOCKED_ACCESS" if blocked else "FAILED", downloaded=False, bytes=0, files={},
                         trainEligible=False, error=f"{type(exc).__name__}: {str(exc)[:300]}")
        entry["seconds"] = round(time.time() - t0, 1)
        entry["checkedAt"] = utc_now()
        entries[name] = {**entries.get(name, {}), **entry}
        print(f"== {name}: {entry['status']} {entry['bytes'] / 1e9:.2f} GB ({entry['seconds']}s)"
              + (f" -> {entry.get('error')}" if entry.get("error") else ""), flush=True)
        write_json(manifest_path, {"datasetVersion": "TURNITING_DATASET_V2", "updatedAt": utc_now(),
                                   "reusedFromV1": ["iberautextification", "autextification2023", "semeval2024_task8",
                                                    "m4", "mage", "hc3", "hc3_chinese", "raid", "turingbench",
                                                    "ghostbuster_essay"],
                                   "notDownloaded": NOT_DOWNLOADED, "datasets": entries})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
