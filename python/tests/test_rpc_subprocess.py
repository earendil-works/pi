"""RPC mode subprocess stdin integration."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PYTHON_SRC = str(Path(__file__).resolve().parents[1] / "src")


def test_rpc_mode_reads_piped_stdin(tmp_path) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    env = {
        **os.environ,
        "PYTHONPATH": PYTHON_SRC,
        "PI_AGENT_DIR": str(agent_dir),
    }
    command = [
        sys.executable,
        "-m",
        "pi_mono.coding_agent",
        "--mode",
        "rpc",
        "--provider",
        "faux",
        "--no-extensions",
    ]
    completed = subprocess.run(
        command,
        input='{"type":"get_state","id":"rpc-1"}\n',
        capture_output=True,
        text=True,
        env=env,
        timeout=45,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    assert lines, f"expected stdout JSONL, got stderr={completed.stderr!r}"
    response = json.loads(lines[0])
    assert response["type"] == "response"
    assert response["command"] == "get_state"
    assert response["success"] is True
    assert response["id"] == "rpc-1"
