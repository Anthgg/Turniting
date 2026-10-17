"""Transformer backends for CANDIDATE_MODEL_V2 and CANDIDATE_MODEL_V3 (CPU / CUDA / MPS).

torch and transformers are imported lazily so the service starts (and /health stays ok)
on machines without them or without the weights.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np


def pick_device(preference: str) -> str:
    import torch

    if preference == "cuda" or (preference == "auto" and torch.cuda.is_available()):
        return "cuda" if torch.cuda.is_available() else "cpu"
    if preference == "mps" or preference == "auto":
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    return "cpu"


class TransformerBackend:
    kind = "base"

    def __init__(self, root: Path, device: str, cpu_threads: int):
        self.root = Path(root)
        self.device_pref = device
        self.cpu_threads = cpu_threads
        self.device = "cpu"
        self.model = None
        self.tokenizer = None
        self.param_count = 0

    @property
    def tokenizer_dir(self) -> Path:
        return self.root

    def load(self) -> None:
        import torch
        from transformers import AutoTokenizer

        torch.set_num_threads(self.cpu_threads)
        self.device = pick_device(self.device_pref)
        self.tokenizer = AutoTokenizer.from_pretrained(self.tokenizer_dir)
        self.model = self._load_model().to(self.device).eval()
        self.param_count = sum(p.numel() for p in self.model.parameters())

    def _load_model(self):  # pragma: no cover - implemented by subclasses
        raise NotImplementedError

    def unload(self) -> None:
        self.model = None
        self.tokenizer = None
        try:
            import gc

            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:  # pragma: no cover
            pass

    @property
    def memory_mb(self) -> int:
        return int(self.param_count * 4 / 1e6)

    def encode(self, text: str, offsets: bool = False):
        enc = self.tokenizer(
            text,
            add_special_tokens=False,
            truncation=False,
            return_offsets_mapping=offsets,
        )
        return enc["input_ids"], (enc["offset_mapping"] if offsets else None)

    @property
    def special(self) -> tuple[int, int, int]:
        t = self.tokenizer
        return t.cls_token_id, t.sep_token_id, t.pad_token_id

    def window_logits(
        self, windows: list[list[int]], batch_size: int = 16
    ) -> np.ndarray:
        """Log-odds of MACHINE_SIGNAL for each token window (already with special tokens)."""
        import torch

        if not windows:
            return np.zeros(0, dtype=np.float32)
        _, _, pad = self.special
        order = np.argsort([len(w) for w in windows], kind="stable")
        out = np.zeros(len(windows), dtype=np.float32)
        with torch.inference_mode():
            for start in range(0, len(order), batch_size):
                idx = order[start : start + batch_size]
                longest = max(len(windows[k]) for k in idx)
                ids = torch.full((len(idx), longest), pad, dtype=torch.long)
                mask = torch.zeros((len(idx), longest), dtype=torch.long)
                for row, k in enumerate(idx):
                    ids[row, : len(windows[k])] = torch.tensor(windows[k])
                    mask[row, : len(windows[k])] = 1
                with torch.autocast(
                    "cuda", dtype=torch.bfloat16, enabled=self.device == "cuda"
                ):
                    logits = self._forward(ids.to(self.device), mask.to(self.device))
                out[idx] = logits.float().cpu().numpy()
        return out

    def _forward(self, ids, mask):  # pragma: no cover - implemented by subclasses
        raise NotImplementedError


class V2Backend(TransformerBackend):
    kind = "v2_sequence_classifier"

    def _load_model(self):
        from transformers import AutoModelForSequenceClassification

        return AutoModelForSequenceClassification.from_pretrained(self.root)

    def _forward(self, ids, mask):
        out = self.model(input_ids=ids, attention_mask=mask).logits
        return out[:, 1] - out[:, 0]


def _v3_module():
    import torch
    from torch import nn

    class V3Detector(nn.Module):
        """Inference copy of training/src/turniting_train/v3model.py (same parameter names)."""

        def __init__(self, backbone, hidden: int):
            super().__init__()
            self.backbone = backbone
            self.dropout = nn.Dropout(0.1)
            self.pool = nn.Sequential(nn.Linear(hidden, hidden), nn.GELU())
            self.head_a = nn.Linear(hidden, 1)
            self.head_b = nn.Linear(hidden, 4)
            self.head_c = nn.Linear(hidden, 1)

        def forward(self, input_ids, attention_mask):
            hs = self.backbone(
                input_ids=input_ids, attention_mask=attention_mask
            ).last_hidden_state
            return self.head_a(self.pool(self.dropout(hs[:, 0]))).squeeze(-1)

    return V3Detector, torch


class V3Backend(TransformerBackend):
    kind = "v3_multitask"

    @property
    def tokenizer_dir(self) -> Path:
        return self.root / "backbone"

    def _load_model(self):
        from transformers import AutoModel

        V3Detector, torch = _v3_module()
        backbone = AutoModel.from_pretrained(self.root / "backbone")
        model = V3Detector(backbone, backbone.config.hidden_size)
        heads = torch.load(
            self.root / "heads.pt", map_location="cpu", weights_only=True
        )
        result = model.load_state_dict(heads, strict=False)
        unexpected = [k for k in result.unexpected_keys]
        missing = [k for k in result.missing_keys if not k.startswith("backbone.")]
        if unexpected or missing:
            raise RuntimeError(
                f"V3 heads mismatch: missing={missing} unexpected={unexpected}"
            )
        return model

    def _forward(self, ids, mask):
        return self.model(ids, mask)


BACKENDS = {"v2_sequence_classifier": V2Backend, "v3_multitask": V3Backend}
