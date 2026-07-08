"""Fast deterministic hash to shorten long strings."""

import ctypes


def short_hash(s: str) -> str:
    h1 = 0xDEADBEEF
    h2 = 0x41C6CE57
    for ch in s.encode("utf-8"):
        h1 = _imul(h1 ^ ch, 2654435761)
        h2 = _imul(h2 ^ ch, 1597334677)
    h1 = _imul(h1 ^ (h1 >> 16), 2246822507) ^ _imul(h2 ^ (h2 >> 13), 3266489909)
    h2 = _imul(h2 ^ (h2 >> 16), 2246822507) ^ _imul(h1 ^ (h1 >> 13), 3266489909)
    return f"{h2 & 0xFFFFFFFF:x}" + f"{h1 & 0xFFFFFFFF:x}"


def _imul(a: int, b: int) -> int:
    """32-bit signed integer multiplication (like Math.imul)."""
    return ctypes.c_int32(a * b).value
