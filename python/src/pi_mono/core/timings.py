import os
import sys
import time
from typing import List, Tuple

ENABLED = os.environ.get("PI_TIMING") == "1"
_timings: List[Tuple[str, int]] = []
_last_time = time.time()


def reset_timings() -> None:
    global _last_time
    if not ENABLED:
        return
    _timings.clear()
    _last_time = time.time()


def time_label(label: str) -> None:
    global _last_time
    if not ENABLED:
        return
    now = time.time()
    # Store ms as int
    ms = int((now - _last_time) * 1000)
    _timings.append((label, ms))
    _last_time = now


def print_timings() -> None:
    if not ENABLED or len(_timings) == 0:
        return
    sys.stderr.write("\n--- Startup Timings ---\n")
    total = 0
    for label, ms in _timings:
        sys.stderr.write(f"  {label}: {ms}ms\n")
        total += ms
    sys.stderr.write(f"  TOTAL: {total}ms\n")
    sys.stderr.write("------------------------\n\n")
    sys.stderr.flush()
