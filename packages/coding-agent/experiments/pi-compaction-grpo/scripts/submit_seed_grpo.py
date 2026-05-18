#!/usr/bin/env python3
"""Submit the seed GRPO JSONL to a local Kiln server."""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def post_json(url: str, payload: dict, timeout: int = 120) -> dict:
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


def load_groups(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


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
    ap.add_argument("--file", type=Path, default=ROOT / "data" / "seed-grpo-groups.jsonl")
    ap.add_argument("--adapter", default="pi-compaction-seed-v001")
    ap.add_argument("--lora-rank", type=int, default=16)
    ap.add_argument("--auto-load", action=argparse.BooleanOptionalAction, default=False)
    ap.add_argument("--wait", action="store_true")
    ap.add_argument("--timeout-s", type=int, default=900)
    args = ap.parse_args()

    groups = load_groups(args.file)
    response = post_json(
        f"{args.kiln_url}/v1/train/grpo",
        {
            "groups": groups,
            "config": {
                "output_name": args.adapter,
                "lora_rank": args.lora_rank,
                "learning_rate": 1e-5,
                "kl_coeff": 0.1,
                "clip_epsilon": 0.2,
                "auto_load": args.auto_load,
            },
        },
    )
    status = wait_job(args.kiln_url, response["job_id"], args.timeout_s) if args.wait else response
    out_dir = ROOT / "results" / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{args.adapter}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "seed-submit-job.json").write_text(json.dumps(status, indent=2, sort_keys=True))
    print(json.dumps({"job": status, "results_dir": str(out_dir)}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

