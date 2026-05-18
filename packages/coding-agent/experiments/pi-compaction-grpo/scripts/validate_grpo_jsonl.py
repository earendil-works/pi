#!/usr/bin/env python3
"""Validate Kiln GRPO JSONL shape."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def validate(path: Path) -> tuple[int, int]:
    groups = 0
    completions = 0
    for line_no, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row.get("messages"), list) or not row["messages"]:
            raise ValueError(f"line {line_no}: messages must be a non-empty list")
        if not isinstance(row.get("completions"), list) or len(row["completions"]) < 2:
            raise ValueError(f"line {line_no}: completions must contain at least 2 items")
        for msg in row["messages"]:
            if msg.get("role") not in {"system", "user", "assistant", "tool"}:
                raise ValueError(f"line {line_no}: invalid message role {msg.get('role')!r}")
            if not isinstance(msg.get("content"), str):
                raise ValueError(f"line {line_no}: message content must be a string")
        for completion in row["completions"]:
            if not isinstance(completion.get("text"), str):
                raise ValueError(f"line {line_no}: completion text must be a string")
            reward = completion.get("reward")
            if not isinstance(reward, (int, float)):
                raise ValueError(f"line {line_no}: completion reward must be numeric")
            completions += 1
        groups += 1
    return groups, completions


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} <grpo-groups.jsonl>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    groups, completions = validate(path)
    print(f"valid GRPO JSONL: groups={groups} completions={completions} path={path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

