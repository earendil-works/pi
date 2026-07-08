"""Stdout guard behavior for print mode."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PYTHON_SRC = str(Path(__file__).resolve().parents[1] / "src")


def test_print_mode_writes_assistant_text_to_stdout_when_piped(tmp_path) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    env = {
        **os.environ,
        "PYTHONPATH": PYTHON_SRC,
        "PI_AGENT_DIR": str(agent_dir),
    }
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "pi_mono.coding_agent",
            "-p",
            "Say exactly: ok",
            "--provider",
            "faux",
            "--no-extensions",
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=45,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert "ok" in completed.stdout.lower(), (
        f"expected assistant text on stdout, stdout={completed.stdout!r} stderr={completed.stderr!r}"
    )
