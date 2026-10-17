"""Download the raw layer of TURNITING_DATASET_V1 from pinned official sources.

Resumable (HTTP Range), hash-verified (SHA-256, plus upstream LFS sha256 / Zenodo md5
when published) and guarded by the safe-disk threshold. Writes
datasets/manifests/datasets.json.

    python scripts/download_datasets.py                 # everything
    python scripts/download_datasets.py --only mage hc3
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import subprocess
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import (  # noqa: E402
    CONFIG_DIR,
    MANIFEST_DIR,
    RAW_DIR,
    DiskGuardError,
    ensure_disk,
    load_yaml,
    read_json,
    sha256_file,
    utc_now,
    write_json,
)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "turniting-training/1.0 (research dataset download)"
REGISTRY = MANIFEST_DIR / "datasets.json"


def _retry(fn, attempts: int = 5):
    for attempt in range(attempts):
        try:
            return fn()
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError,
                requests.exceptions.ChunkedEncodingError) as exc:
            if attempt == attempts - 1:
                raise
            wait = min(2 ** (attempt + 1), 60)
            print(f"   retry in {wait}s after: {exc}")
            time.sleep(wait)


def download(url: str, dest: Path, expected_size: int | None = None) -> None:
    """Resumable download through a `.part` file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and (expected_size is None or dest.stat().st_size == expected_size):
        print(f"   cached {dest.name}")
        return
    part = dest.with_name(dest.name + ".part")
    remaining = (expected_size or 0) - (part.stat().st_size if part.exists() else 0)
    ensure_disk(max(remaining, 0) / 1e9, f"download {dest.name}")

    def _go():
        offset = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        with SESSION.get(url, headers=headers, stream=True, timeout=60, allow_redirects=True) as resp:
            if resp.status_code == 416:
                return
            resp.raise_for_status()
            mode = "ab" if offset and resp.status_code == 206 else "wb"
            if mode == "wb" and offset:
                print("   server ignored Range; restarting")
            done = offset if mode == "ab" else 0
            last = time.time()
            with open(part, mode) as handle:
                for block in resp.iter_content(chunk_size=4 * 1024 * 1024):
                    handle.write(block)
                    done += len(block)
                    if time.time() - last > 30:
                        total = expected_size or 0
                        pct = f"{100 * done / total:.1f}%" if total else ""
                        print(f"   {dest.name}: {done / 1e9:.2f} GB {pct}", flush=True)
                        ensure_disk(0, f"download {dest.name}")
                        last = time.time()

    _retry(_go, attempts=30)
    if expected_size is not None and part.stat().st_size != expected_size:
        raise RuntimeError(f"size mismatch for {dest}: {part.stat().st_size} != {expected_size}")
    part.replace(dest)


def md5_file(path: Path) -> str:
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        while block := handle.read(8 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def fetch_hf(name: str, spec: dict, out: Path) -> dict:
    from huggingface_hub import HfApi

    info = HfApi().dataset_info(spec["repo_id"], revision=spec["revision"], files_metadata=True)
    siblings = {s.rfilename: s for s in info.siblings}
    files, hashes, upstream = [], {}, {}
    for rel in spec["files"]:
        sib = siblings[rel]
        url = f"https://huggingface.co/datasets/{spec['repo_id']}/resolve/{spec['revision']}/{rel}"
        dest = out / rel
        print(f"  {rel} ({(sib.size or 0) / 1e6:.1f} MB)")
        download(url, dest, sib.size)
        digest = sha256_file(dest)
        lfs = getattr(sib, "lfs", None)
        lfs_sha = (lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)) if lfs else None
        if lfs_sha and lfs_sha != digest:
            raise RuntimeError(f"sha256 mismatch for {rel}: {digest} vs upstream {lfs_sha}")
        files.append(rel)
        hashes[rel] = digest
        upstream[rel] = {"size": sib.size, "lfs_sha256": lfs_sha}
    return {
        "source": f"https://huggingface.co/datasets/{spec['repo_id']}",
        "version": spec["revision"],
        "license": next((t.split(":", 1)[1] for t in info.tags or [] if t.startswith("license:")), None),
        "files": files,
        "sha256": hashes,
        "upstream": upstream,
    }


def fetch_zenodo(name: str, spec: dict, out: Path) -> dict:
    meta = _retry(lambda: SESSION.get(f"https://zenodo.org/api/records/{spec['record']}", timeout=60))
    meta.raise_for_status()
    record = meta.json()
    access = record["metadata"].get("access_right")
    available = {f["key"]: f for f in record.get("files", [])}
    entry = {
        "source": f"https://zenodo.org/records/{spec['record']}",
        "version": record["metadata"].get("version") or record.get("revision"),
        "license": (record["metadata"].get("license") or {}).get("id"),
        "access_right": access,
        "files": [],
        "sha256": {},
        "upstream": {},
    }
    wanted = spec.get("files") or list(available)
    if access != "open" or not available:
        entry["status"] = "BLOCKED_ACCESS"
        entry["blocked_reason"] = (
            f"Zenodo record {spec['record']} access_right={access}; files require owner approval"
        )
        return entry
    for key in wanted:
        f = available[key]
        dest = out / key
        print(f"  {key} ({f['size'] / 1e6:.1f} MB)")
        download(f["links"]["self"], dest, f["size"])
        algo, _, value = f["checksum"].partition(":")
        if algo == "md5" and md5_file(dest) != value:
            raise RuntimeError(f"md5 mismatch for {key}")
        entry["files"].append(key)
        entry["sha256"][key] = sha256_file(dest)
        entry["upstream"][key] = {"size": f["size"], "checksum": f["checksum"]}
    return entry


def _github_head(repo: str) -> str:
    resp = _retry(lambda: SESSION.get(f"https://api.github.com/repos/{repo}/commits/HEAD", timeout=60))
    resp.raise_for_status()
    return resp.json()["sha"]


def fetch_github_raw(name: str, spec: dict, out: Path) -> dict:
    commit = spec.get("commit") or _github_head(spec["repo"])
    listing = _retry(lambda: SESSION.get(
        f"https://api.github.com/repos/{spec['repo']}/contents/{spec['path']}?ref={commit}", timeout=60))
    listing.raise_for_status()
    entry = {"source": f"https://github.com/{spec['repo']}", "version": commit, "license": None,
             "files": [], "sha256": {}, "upstream": {}}
    for item in listing.json():
        if item["type"] != "file" or not fnmatch.fnmatch(item["name"], spec.get("pattern", "*")):
            continue
        url = f"https://raw.githubusercontent.com/{spec['repo']}/{commit}/{item['path']}"
        print(f"  {item['name']} ({item['size'] / 1e6:.1f} MB)")
        dest = out / item["name"]
        download(url, dest, item["size"])
        entry["files"].append(item["name"])
        entry["sha256"][item["name"]] = sha256_file(dest)
        entry["upstream"][item["name"]] = {"size": item["size"], "git_blob_sha": item["sha"]}
    return entry


def fetch_github_tree(name: str, spec: dict, out: Path) -> dict:
    """Sparse, blobless clone of one sub-tree (many small files)."""
    commit = spec.get("commit") or _github_head(spec["repo"])
    repo_dir = out / "repo"
    if not (repo_dir / ".git").exists():
        ensure_disk(0.5, f"clone {spec['repo']}")
        subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", "--quiet",
                        f"https://github.com/{spec['repo']}.git", str(repo_dir)], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "sparse-checkout", "set", "--no-cone",
                    f"/{spec['path']}/", *[f"/{f}" for f in spec.get("extra_files", [])]], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "checkout", "--quiet", commit], check=True)
    files = sorted(p for p in (repo_dir / spec["path"]).rglob("*") if p.is_file())
    tree_hash = hashlib.sha256()
    hashes = {}
    for path in files:
        rel = path.relative_to(repo_dir).as_posix()
        digest = sha256_file(path)
        hashes[rel] = digest
        tree_hash.update(f"{rel}:{digest}\n".encode())
    return {
        "source": f"https://github.com/{spec['repo']}",
        "version": commit,
        "license": None,
        "files": [f"{spec['path']}/** ({len(files)} files)"] + spec.get("extra_files", []),
        # Thousands of tiny files: store one aggregate digest over sorted (path, sha256).
        "sha256": {f"{spec['path']}/**": tree_hash.hexdigest()},
        "upstream": {"file_count": len(files)},
    }


FETCHERS = {
    "hf": fetch_hf,
    "zenodo": fetch_zenodo,
    "github_raw": fetch_github_raw,
    "github_tree": fetch_github_tree,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="*", help="dataset keys to fetch")
    parser.add_argument("--config", default=str(CONFIG_DIR / "datasets.yaml"))
    args = parser.parse_args()
    config = load_yaml(Path(args.config))
    registry = read_json(REGISTRY, default={"datasets": {}})
    failures = 0
    for name, spec in config["datasets"].items():
        if args.only and name not in args.only:
            continue
        print(f"== {name} ({spec['kind']})", flush=True)
        out = RAW_DIR / name
        out.mkdir(parents=True, exist_ok=True)
        previous = registry["datasets"].get(name, {})
        try:
            entry = FETCHERS[spec["kind"]](name, spec, out)
            entry.setdefault("status", "DOWNLOADED")
        except DiskGuardError as exc:
            entry = {**previous, "status": "BLOCKED_DISK", "blocked_reason": str(exc)}
            failures += 1
        except Exception as exc:  # recorded, not hidden
            entry = {**previous, "status": "FAILED", "blocked_reason": f"{type(exc).__name__}: {exc}"}
            failures += 1
        entry["name"] = name
        entry["kind"] = spec["kind"]
        entry["downloadedAt"] = utc_now()
        # Fields filled by build_dataset.py are preserved across re-downloads.
        for key in ("rows", "languages", "domains", "generators"):
            if key in previous:
                entry.setdefault(key, previous[key])
        # Re-read so concurrent downloads (e.g. RAID in background) don't clobber each other.
        registry = read_json(REGISTRY, default={"datasets": {}})
        registry["datasets"][name] = entry
        registry["updatedAt"] = utc_now()
        write_json(REGISTRY, registry)
        print(f"   -> {entry['status']}", entry.get("blocked_reason", ""), flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
