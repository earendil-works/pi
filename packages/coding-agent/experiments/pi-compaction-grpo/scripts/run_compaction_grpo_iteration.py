#!/usr/bin/env python3
"""Generate, score, and submit one Pi-compaction GRPO iteration to Kiln."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCORER = ROOT / "scripts" / "score_compaction.py"
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
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from e


def get_json(url: str, timeout: int = 30) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def load_jsonl(path: Path, limit: int) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
        if len(rows) >= limit:
            break
    return rows


def trim_source(source: str, char_budget: int) -> str:
    """Keep the prompt bounded while preserving system context and recent state."""
    if char_budget <= 0 or len(source) <= char_budget:
        return source
    head_budget = min(2200, char_budget // 3)
    tail_budget = char_budget - head_budget
    return (
        source[:head_budget].rstrip()
        + "\n\n[... middle of trajectory omitted for training memory ...]\n\n"
        + source[-tail_budget:].lstrip()
    )


def prepare_row(row: dict, source_char_budget: int) -> dict:
    if source_char_budget <= 0:
        return row
    out = dict(row)
    out["source"] = trim_source(row["source"], source_char_budget)
    metadata = dict(out.get("metadata", {}))
    metadata["source_chars_original"] = len(row["source"])
    metadata["source_chars_used"] = len(out["source"])
    out["metadata"] = metadata
    return out


def prompt_for(row: dict) -> list[dict]:
    return [
        {
            "role": "user",
            "content": (
                "Create a Pi context compaction summary for the conversation in "
                "<conversation>. Use the exact Pi checkpoint headings. Preserve "
                "the user's goal, constraints, done/in-progress/blocked state, "
                "exact paths/commands/IDs/errors, and concrete next steps. "
                "Do not fabricate completed work.\n\n"
                f"<conversation>\n{row['source']}\n</conversation>"
            ),
        }
    ]


def score(row: dict, text: str) -> float:
    payload = {
        "source": row["source"],
        "candidate": text,
        "read_files": row.get("read_files", []),
        "modified_files": row.get("modified_files", []),
        "critical_entities": row.get("critical_entities", []),
    }
    proc = subprocess.run(
        [sys.executable, str(SCORER)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)["score"]


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
    ap.add_argument("--limit", type=int, default=4)
    ap.add_argument("--n", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=900)
    ap.add_argument("--source-char-budget", type=int, default=0)
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--seed", type=int, default=18051801)
    ap.add_argument("--adapter", default="pi-compaction-grpo-v001")
    ap.add_argument("--lora-rank", type=int, default=16)
    ap.add_argument("--learning-rate", type=float, default=1e-5)
    ap.add_argument("--kl-coeff", type=float, default=0.1)
    ap.add_argument("--clip-epsilon", type=float, default=0.2)
    ap.add_argument("--wait", action="store_true")
    ap.add_argument("--auto-load", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--job-timeout-s", type=int, default=900)
    args = ap.parse_args()

    rows = [prepare_row(r, args.source_char_budget) for r in load_jsonl(args.prompts, args.limit)]
    prompts = [prompt_for(r) for r in rows]

    health = get_json(f"{args.kiln_url}/health")
    if health.get("training", {}).get("active_job") is not None:
        raise RuntimeError(f"Kiln already has active training job: {health['training']}")

    batch = post_json(
        f"{args.kiln_url}/v1/completions/batch",
        {
            "prompts": prompts,
            "n": args.n,
            "temperature": args.temperature,
            "max_tokens": args.max_tokens,
            "seed": args.seed,
            "sampling_preset": "qwen3-non-thinking-general",
            "chat_template_kwargs": {"enable_thinking": False},
        },
        timeout=900,
    )

    groups = [{"messages": prompt_for(row), "completions": []} for row in rows]
    scored_rows = []
    for item in batch["completions"]:
        pi = item["prompt_index"]
        text = item.get("text") or item.get("reasoning_content") or ""
        reward = score(rows[pi], text)
        groups[pi]["completions"].append({"text": text, "reward": reward})
        scored_rows.append({"prompt_index": pi, "reward": reward, "text": text})

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    results_dir = ROOT / "results" / f"{ts}-{args.adapter}"
    results_dir.mkdir(parents=True, exist_ok=True)
    grpo_path = results_dir / "groups.jsonl"
    grpo_path.write_text("\n".join(json.dumps(g, ensure_ascii=False) for g in groups) + "\n")
    (results_dir / "scored-completions.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in scored_rows) + "\n"
    )
    mean_reward = sum(r["reward"] for r in scored_rows) / max(len(scored_rows), 1)

    job = post_json(
        f"{args.kiln_url}/v1/train/grpo",
        {
            "groups": groups,
            "config": {
                "learning_rate": args.learning_rate,
                "kl_coeff": args.kl_coeff,
                "clip_epsilon": args.clip_epsilon,
                "lora_rank": args.lora_rank,
                "output_name": args.adapter,
                "auto_load": args.auto_load,
            },
        },
        timeout=120,
    )
    job_status = wait_job(args.kiln_url, job["job_id"], args.job_timeout_s) if args.wait else job
    (results_dir / "job.json").write_text(json.dumps(job_status, indent=2, sort_keys=True))

    ledger = {
        "iter": None,
        "slug": args.adapter,
        "ts": datetime.now(timezone.utc).isoformat(),
        "status": "submitted" if not args.wait else job_status.get("state", "unknown"),
        "score": mean_reward,
        "hypothesis": "Online GRPO on real trajectory compaction prompts should lift scorer reward over seed smoke data.",
        "prompt_set": str(args.prompts),
        "scorer": "scripts/score_compaction.py@v0.3",
        "adapter": args.adapter,
        "training": {
            "job_id": job["job_id"],
            "lora_rank": args.lora_rank,
            "learning_rate": args.learning_rate,
            "kl_coeff": args.kl_coeff,
            "clip_epsilon": args.clip_epsilon,
            "groups": len(groups),
            "completions": len(scored_rows),
            "max_tokens": args.max_tokens,
            "source_char_budget": args.source_char_budget,
        },
        "artifacts": [str(grpo_path), str(results_dir / "scored-completions.jsonl"), str(results_dir / "job.json")],
        "verdict": "pending_eval",
        "next_focus": "Evaluate adapter on held-out compaction prompts, then adjust prompt diversity or scorer penalties.",
    }
    with LEDGER.open("a") as f:
        f.write(json.dumps(ledger, ensure_ascii=False) + "\n")

    print(json.dumps({"mean_reward": mean_reward, "job": job_status, "results_dir": str(results_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
