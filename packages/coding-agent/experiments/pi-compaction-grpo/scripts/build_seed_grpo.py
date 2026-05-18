#!/usr/bin/env python3
"""Build a seed GRPO JSONL from calibration cases.

This is not a final training set. It is a smoke/seed dataset that verifies the
reward shape and gives the adapter a first contrastive signal: operational
compaction summaries should outrank generic or hallucinated summaries.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCORER = ROOT / "scripts" / "score_compaction.py"


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def score(payload: dict, candidate: str) -> float:
    scored_payload = dict(payload)
    scored_payload["candidate"] = candidate
    proc = subprocess.run(
        [sys.executable, str(SCORER)],
        input=json.dumps(scored_payload),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)["score"]


def prompt_for(payload: dict) -> list[dict]:
    source = payload["source"]
    return [
        {
            "role": "user",
            "content": (
                "Create a Pi context compaction summary for the conversation in "
                "<conversation>. Use the exact Pi checkpoint headings, preserve "
                "file paths, commands, blockers, current state, and next actions. "
                "Do not fabricate completed work.\n\n"
                f"<conversation>\n{source}\n</conversation>"
            ),
        }
    ]


def main() -> int:
    good = load_jsonl(ROOT / "calibration" / "good.jsonl")
    bad = load_jsonl(ROOT / "calibration" / "bad.jsonl")
    out_path = ROOT / "data" / "seed-grpo-groups.jsonl"

    rows = []
    # Group 1: one good summary against two bad summaries for the same source.
    base = good[0]
    completions = [{"text": base["candidate"], "reward": score(base, base["candidate"])}]
    for bad_case in bad:
        adapted = dict(base)
        adapted["candidate"] = bad_case["candidate"]
        completions.append({"text": bad_case["candidate"], "reward": score(adapted, bad_case["candidate"])})
    rows.append({"messages": prompt_for(base), "completions": completions})

    # Group 2+: each bad source gets a minimal repair completion and its original bad completion.
    for bad_case in bad:
        repair = (
            "## Goal\n"
            "Continue the Pi compaction GRPO work without claiming it is complete.\n\n"
            "## Constraints & Preferences\n"
            "- Preserve exact paths, current blockers, B2 upload status, and adapter/baseline status.\n"
            "- Do not fabricate trained adapters or successful uploads.\n\n"
            "## Progress\n"
            "### Done\n"
            "- [x] A scorer draft exists.\n\n"
            "### In Progress\n"
            "- [ ] Calibrate the scorer and prepare the first GRPO dataset.\n\n"
            "### Blocked\n"
            "- No GRPO adapter, baseline, or successful B2 sync exists yet.\n\n"
            "## Key Decisions\n"
            "- **Scorer first**: training should wait until the reward function passes calibration.\n\n"
            "## Next Steps\n"
            "1. Run the scorer calibration gate.\n"
            "2. Build a scored GRPO JSONL.\n"
            "3. Submit it to Kiln once a server is available and sync artifacts to B2.\n\n"
            "## Critical Context\n"
            "- Relevant artifact: `/workspace/pi-compaction-grpo/scripts/score_compaction.py`.\n"
        )
        rows.append(
            {
                "messages": prompt_for(bad_case),
                "completions": [
                    {"text": repair, "reward": score(bad_case, repair)},
                    {"text": bad_case["candidate"], "reward": score(bad_case, bad_case["candidate"])},
                ],
            }
        )

    out_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
    print(f"wrote {out_path} ({len(rows)} groups)")
    for i, row in enumerate(rows):
        rewards = [c["reward"] for c in row["completions"]]
        print(f"group {i}: rewards={['%.4f' % r for r in rewards]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

