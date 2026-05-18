#!/usr/bin/env python3
"""Regression checks for the Pi compaction scorer and target generator."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import run_compaction_contrast_iteration as contrast  # noqa: E402
import score_compaction  # noqa: E402


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class ScorerCalibrationTest(unittest.TestCase):
    def test_good_calibration_stays_high(self) -> None:
        rows = load_jsonl(ROOT / "calibration" / "good.jsonl")
        scores = [score_compaction.score_payload(row)["score"] for row in rows]
        self.assertGreaterEqual(min(scores), 0.75)

    def test_bad_calibration_stays_low(self) -> None:
        rows = load_jsonl(ROOT / "calibration" / "bad.jsonl")
        scores = [score_compaction.score_payload(row)["score"] for row in rows]
        self.assertLessEqual(max(scores), 0.35)

    def test_malformed_encoded_heading_is_penalized(self) -> None:
        source = (
            "[User]: Continue the Pi compaction GRPO work. Current blocker: "
            "RunPod capacity error. Use `/workspace/pi-compaction-grpo` and sync to B2."
        )
        candidate = (
            "# Pi%20Compaction++++12345\n"
            "Goal\n"
            "Continue.\n"
            "Progress\n"
            "Done.\n"
            "Next Steps\n"
            "1. Keep going."
        )
        result = score_compaction.score_payload(
            {
                "source": source,
                "candidate": candidate,
                "critical_entities": ["/workspace/pi-compaction-grpo", "RunPod", "B2"],
            }
        )
        self.assertLess(result["score"], 0.4)
        self.assertIn("malformed_or_encoded_output", result["penalties"])
        self.assertIn("missing_exact_pi_headings", result["penalties"])


class TargetGeneratorTest(unittest.TestCase):
    def test_task_notification_does_not_become_goal_or_path_context(self) -> None:
        rows = load_jsonl(ROOT / "data" / "trajectory-compaction-prompts-v3.jsonl")
        row = next(r for r in rows if r.get("session_id") == "22a249e6-16ac-455a-b4dc-ea4421b7fe9d")
        prepared = contrast.prepare_row(row, 1200)
        target = contrast.heuristic_positive(prepared)

        goal_block = target.split("## Constraints & Preferences", 1)[0]
        self.assertNotIn("<task-notification>", goal_block)
        self.assertNotIn("<tool-use-id>", goal_block)

        critical_context = target.split("## Critical Context", 1)[1]
        for pseudo_path in ("/task-id", "/tool-use-id", "/output-file", "/summary", "/analysis", "/status"):
            self.assertNotIn(pseudo_path, critical_context)

    def test_v3_targets_clear_quality_floor(self) -> None:
        rows = load_jsonl(ROOT / "data" / "trajectory-compaction-prompts-v3.jsonl")
        scores = []
        for row in rows:
            prepared = contrast.prepare_row(row, 1200)
            target = contrast.heuristic_positive(prepared)
            scores.append(
                score_compaction.score_payload(
                    {
                        "source": prepared["source"],
                        "candidate": target,
                        "read_files": prepared.get("read_files", []),
                        "modified_files": prepared.get("modified_files", []),
                        "critical_entities": prepared.get("critical_entities", []),
                    }
                )["score"]
            )
        self.assertGreaterEqual(min(scores), 0.72)
        self.assertGreaterEqual(sum(scores) / len(scores), 0.77)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
