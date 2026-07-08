"""Shared pytest setup for pi-mono-python."""

from __future__ import annotations

import sys

if sys.version_info < (3, 11):
    raise RuntimeError(
        "pi-mono-python requires Python 3.11 or newer "
        f"(running {sys.version.split()[0]}). "
        "Install deps with: cd python && python3.11 -m pip install -e '.[dev]' "
        "then run: python3.11 -m pytest tests/test_cursor.py"
    )
