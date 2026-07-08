"""Re-export unified stdout guard (see pi_mono.core.output_guard)."""

from pi_mono.core.output_guard import (
    flush_raw_stdout,
    is_stdout_taken_over,
    restore_stdout,
    take_over_stdout,
    wait_for_raw_stdout_backpressure,
    write_raw_stdout,
)

__all__ = [
    "flush_raw_stdout",
    "is_stdout_taken_over",
    "restore_stdout",
    "take_over_stdout",
    "wait_for_raw_stdout_backpressure",
    "write_raw_stdout",
]
