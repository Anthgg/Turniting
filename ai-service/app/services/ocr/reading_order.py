from collections.abc import Sequence
from typing import Any


def sort_reading_order(
    blocks: Sequence[dict[str, Any]], page_width: float
) -> list[dict[str, Any]]:
    """Sort top-to-bottom and left-to-right, reading clear columns by column."""
    if len(blocks) < 2:
        return [dict(block) for block in blocks]

    valid = [block for block in blocks if _bbox(block) is not None]
    invalid = [block for block in blocks if _bbox(block) is None]
    centers = sorted((_bbox(block)[0] + _bbox(block)[2]) / 2 for block in valid)
    split_index = -1
    largest_gap = 0.0
    for index in range(1, len(centers)):
        gap = centers[index] - centers[index - 1]
        if gap > largest_gap:
            largest_gap = gap
            split_index = index

    if (
        split_index > 0
        and len(valid) >= 4
        and largest_gap >= page_width * 0.18
        and split_index >= 2
        and len(valid) - split_index >= 2
    ):
        split_x = (centers[split_index - 1] + centers[split_index]) / 2
        ordered = sorted(
            valid,
            key=lambda block: (
                0 if _center_x(block) < split_x else 1,
                _bbox(block)[1],
                _bbox(block)[0],
            ),
        )
    else:
        ordered = sorted(valid, key=lambda block: (_bbox(block)[1], _bbox(block)[0]))

    return [dict(block) for block in ordered + invalid]


def _bbox(block: dict[str, Any]) -> tuple[float, float, float, float] | None:
    value = block.get("bbox")
    if not isinstance(value, dict):
        return None
    try:
        bounds = tuple(float(value[key]) for key in ("x0", "y0", "x1", "y1"))
    except (KeyError, TypeError, ValueError):
        return None
    if not all(map(_finite, bounds)) or bounds[2] < bounds[0] or bounds[3] < bounds[1]:
        return None
    return bounds


def _center_x(block: dict[str, Any]) -> float:
    bounds = _bbox(block)
    return (bounds[0] + bounds[2]) / 2 if bounds else 0


def _finite(value: float) -> bool:
    return value == value and abs(value) != float("inf")
