"""Shared helpers: paths, hashing, disk guard, seeds, environment capture."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import random
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TRAINING_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = TRAINING_DIR.parent
CONFIG_DIR = TRAINING_DIR / "configs"
DATASETS_DIR = TRAINING_DIR / "datasets"
RAW_DIR = DATASETS_DIR / "raw"
NORMALIZED_DIR = DATASETS_DIR / "normalized"
MANIFEST_DIR = DATASETS_DIR / "manifests"
CACHE_DIR = DATASETS_DIR / "cache"
MODELS_DIR = TRAINING_DIR / "models"
CHECKPOINT_DIR = TRAINING_DIR / "checkpoints"
REPORTS_DIR = TRAINING_DIR / "reports"

DATASET_VERSION = "TURNITING_DATASET_V1"
MODEL_VERSION = "TURNITING_AI_V1"
MODEL_DISPLAY_NAME = "Turniting AI Detector V1"

HUMAN = 0
MACHINE = 1


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path, chunk: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_yaml(path: Path) -> dict[str, Any]:
    import yaml

    with open(path, encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False, default=str)
        handle.write("\n")
    os.replace(tmp, path)


class DiskGuardError(RuntimeError):
    pass


def disk_status(path: Path = TRAINING_DIR) -> dict[str, float]:
    usage = shutil.disk_usage(path)
    return {
        "total_gb": usage.total / 1e9,
        "free_gb": usage.free / 1e9,
        "used_gb": usage.used / 1e9,
    }


def safe_free_threshold_gb(min_free_gb: float = 10.0, min_fraction: float = 0.10) -> float:
    total = shutil.disk_usage(TRAINING_DIR).total / 1e9
    return max(min_free_gb, total * min_fraction)


def ensure_disk(required_gb: float = 0.0, what: str = "operation") -> None:
    """Abort cleanly when `required_gb` more bytes would cross the safe threshold."""
    free = disk_status()["free_gb"]
    threshold = safe_free_threshold_gb()
    if free - required_gb < threshold:
        raise DiskGuardError(
            f"{what}: needs {required_gb:.2f} GB but only {free:.2f} GB free "
            f"(safe threshold {threshold:.2f} GB)"
        )


def set_seed(seed: int) -> None:
    random.seed(seed)
    os.environ["PYTHONHASHSEED"] = str(seed)
    try:
        import numpy as np

        np.random.seed(seed)
    except ImportError:
        pass
    try:
        import torch

        torch.manual_seed(seed)
    except ImportError:
        pass


def git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO_DIR, text=True
        ).strip()
    except Exception:
        return "unknown"


def hardware_info() -> dict[str, Any]:
    import psutil

    info: dict[str, Any] = {
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "cpu": platform.processor(),
        "cpu_physical_cores": psutil.cpu_count(logical=False),
        "cpu_logical_cores": psutil.cpu_count(logical=True),
        "ram_gb": round(psutil.virtual_memory().total / 1e9, 2),
        "disk": {k: round(v, 2) for k, v in disk_status().items()},
        "gpu": None,
        "vram_gb": None,
        "cuda": None,
        "mps": False,
    }
    try:
        import torch

        info["torch"] = torch.__version__
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            info["gpu"] = props.name
            info["vram_gb"] = round(props.total_memory / 1e9, 2)
            info["cuda"] = torch.version.cuda
        info["mps"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    except ImportError:
        pass
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-CimInstance Win32_Processor).Name; (Get-CimInstance Win32_VideoController).Name"],
                text=True,
            ).strip().splitlines()
            info["cpu"] = out[0].strip()
            info["display_adapters"] = [line.strip() for line in out[1:] if line.strip()]
        except Exception:
            pass
    return info


def library_versions() -> dict[str, str]:
    versions = {}
    for name in [
        "torch", "transformers", "datasets", "accelerate", "sklearn", "pandas",
        "numpy", "pyarrow", "rapidfuzz", "datasketch", "sentencepiece", "safetensors",
        "huggingface_hub", "langid",
    ]:
        try:
            module = __import__(name)
            versions[name] = getattr(module, "__version__", "unknown")
        except ImportError:
            versions[name] = "missing"
    return versions


def keep_system_awake() -> None:
    """Ask Windows not to idle-sleep while this process runs (no settings changed)."""
    if sys.platform == "win32":
        try:
            import ctypes

            ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        except Exception:
            pass
