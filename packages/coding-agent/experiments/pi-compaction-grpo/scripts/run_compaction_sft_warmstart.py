#!/usr/bin/env python3
"""Train a small SFT warm-start adapter for Pi compaction format emission."""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from run_compaction_contrast_iteration import (
    heuristic_positive,
    load_jsonl,
    prepare_row,
    prompt_for,
    score,
)


ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "experiments" / "ledger.jsonl"


def post_json(url: str, payload: dict, timeout: int = 600) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode()
            return json.loads(body or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from e


def get_json(url: str, timeout: int = 30) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def wait_job(kiln_url: str, job_id: str, timeout_s: int) -> dict:
    deadline = time.time() + timeout_s
    last = {}
    while time.time() < deadline:
        last = get_json(f"{kiln_url}/v1/train/status/{job_id}")
        state = last.get("state") or last.get("status")
        if state in {"completed", "failed", "cancelled"}:
            return last
        time.sleep(5)
    raise TimeoutError(f"job {job_id} did not finish within {timeout_s}s; last={last}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kiln-url", default="http://127.0.0.1:8420")
    ap.add_argument("--prompts", type=Path, default=ROOT / "data" / "trajectory-compaction-prompts.jsonl")
    ap.add_argument("--adapter", default="pi-compaction-sft-warm-v001")
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=4)
    ap.add_argument("--source-char-budget", type=int, default=3000)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lora-rank", type=int, default=4)
    ap.add_argument("--learning-rate", type=float, default=2e-4)
    ap.add_argument("--auto-load", action=argparse.BooleanOptionalAction, default=False)
    ap.add_argument("--wait", action="store_true")
    ap.add_argument("--job-timeout-s", type=int, default=900)
    args = ap.parse_args()

    raw_rows = load_jsonl(args.prompts, args.offset + args.limit)[args.offset : args.offset + args.limit]
    rows = [prepare_row(r, args.source_char_budget) for r in raw_rows]
    examples = []
    scored_targets = []
    for i, row in enumerate(rows):
        target = heuristic_positive(row)
        examples.append({"messages": prompt_for(row) + [{"role": "assistant", "content": target}]})
        scored_targets.append({"prompt_index": i, "target_score": score(row, target), "target": target})

    health = get_json(f"{args.kiln_url}/health")
    if health.get("training", {}).get("active_job") is not None:
        raise RuntimeError(f"Kiln already has active training job: {health['training']}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    results_dir = ROOT / "results" / f"{ts}-{args.adapter}"
    results_dir.mkdir(parents=True, exist_ok=True)
    examples_path = results_dir / "sft-examples.jsonl"
    examples_path.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in examples) + "\n")
    (results_dir / "target-scores.jsonl").write_text(
        "\n".join(json.dumps(s, ensure_ascii=False) for s in scored_targets) + "\n"
    )

    response = post_json(
        f"{args.kiln_url}/v1/train/sft",
        {
            "examples": examples,
            "config": {
                "output_name": args.adapter,
                "auto_load": args.auto_load,
                "learning_rate": args.learning_rate,
                "epochs": args.epochs,
                "lora_rank": args.lora_rank,
            },
        },
        timeout=120,
    )
    job_status = wait_job(args.kiln_url, response["job_id"], args.job_timeout_s) if args.wait else response
    (results_dir / "job.json").write_text(json.dumps(job_status, indent=2, sort_keys=True))
    mean_target_score = sum(s["target_score"] for s in scored_targets) / max(len(scored_targets), 1)

    ledger = {
        "iter": None,
        "slug": args.adapter,
        "ts": datetime.now(timezone.utc).isoformat(),
        "status": "submitted" if not args.wait else job_status.get("state", "unknown"),
        "score": mean_target_score,
        "hypothesis": "A small SFT warm-start on high-scoring Pi-format heuristic summaries should fix empty compaction emissions before GRPO.",
        "prompt_set": str(args.prompts),
        "scorer": "scripts/score_compaction.py@v0.3",
        "adapter": args.adapter,
        "training": {
            "job_id": response["job_id"],
            "lora_rank": args.lora_rank,
            "learning_rate": args.learning_rate,
            "epochs": args.epochs,
            "examples": len(examples),
            "offset": args.offset,
            "source_char_budget": args.source_char_budget,
        },
        "artifacts": [str(examples_path), str(results_dir / "target-scores.jsonl"), str(results_dir / "job.json")],
        "verdict": "pending_eval",
        "next_focus": "Evaluate non-empty held-out generation, then run GRPO using this warm-start as the base adapter if it improves emission.",
    }
    with LEDGER.open("a") as f:
        f.write(json.dumps(ledger, ensure_ascii=False) + "\n")

    print(json.dumps({"mean_target_score": mean_target_score, "job": job_status, "results_dir": str(results_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
