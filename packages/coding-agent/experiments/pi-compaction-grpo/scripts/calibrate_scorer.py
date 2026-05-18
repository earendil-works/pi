#!/usr/bin/env python3
"""Run scorer calibration gates over calibration/*.jsonl."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCORER = ROOT / "scripts" / "score_compaction.py"


def load_jsonl(path: Path):
    for line in path.read_text().splitlines():
        if line.strip():
            yield json.loads(line)


def score(payload: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, str(SCORER)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)


def main() -> int:
    failures = []
    rows = []
    for path, threshold, op in [
        (ROOT / "calibration" / "good.jsonl", 0.75, "ge"),
        (ROOT / "calibration" / "bad.jsonl", 0.35, "le"),
    ]:
        for payload in load_jsonl(path):
            result = score(payload)
            value = result["score"]
            ok = value >= threshold if op == "ge" else value <= threshold
            rows.append((path.name, payload["name"], value, ok, result))
            if not ok:
                failures.append((path.name, payload["name"], value, threshold, op))

    for suite, name, value, ok, result in rows:
        print(f"{suite:10s} {name:28s} score={value:.4f} {'PASS' if ok else 'FAIL'}")
        print("  subscores=" + json.dumps(result["subscores"], sort_keys=True))
        if result["penalties"]:
            print("  penalties=" + json.dumps(result["penalties"], sort_keys=True))

    if failures:
        print("\nCalibration failures:", file=sys.stderr)
        for suite, name, value, threshold, op in failures:
            cmp = ">=" if op == "ge" else "<="
            print(f"- {suite}/{name}: {value:.4f} expected {cmp} {threshold}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

