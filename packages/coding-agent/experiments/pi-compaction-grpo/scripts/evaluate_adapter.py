#!/usr/bin/env python3
"""Evaluate base vs one adapter on held-out compaction prompts."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from run_compaction_contrast_iteration import load_jsonl, prepare_row, prompt_for


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
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


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


def prompt_for_eval(row: dict, cache_salt: str | None) -> list[dict]:
    messages = prompt_for(row)
    if cache_salt:
        messages = [dict(m) for m in messages]
        messages[-1]["content"] += (
            "\n\nEvaluation cache salt: "
            f"{cache_salt}. Ignore this salt when writing the checkpoint summary."
        )
    return messages


def generate(kiln_url: str, row: dict, seed: int, max_tokens: int, temperature: float, cache_salt: str | None) -> str:
    batch = post_json(
        f"{kiln_url}/v1/completions/batch",
        {
            "prompts": [prompt_for_eval(row, cache_salt)],
            "n": 1,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "seed": seed,
            "sampling_preset": "qwen3-non-thinking-general",
            "chat_template_kwargs": {"enable_thinking": False},
        },
        timeout=900,
    )
    item = batch["completions"][0]
    return item.get("text") or item.get("reasoning_content") or ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kiln-url", default="http://127.0.0.1:8420")
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--prompts", type=Path, default=ROOT / "data" / "trajectory-compaction-prompts.jsonl")
    ap.add_argument("--offset", type=int, default=2)
    ap.add_argument("--limit", type=int, default=2)
    ap.add_argument("--source-char-budget", type=int, default=3000)
    ap.add_argument("--max-tokens", type=int, default=350)
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--seed", type=int, default=18051844)
    ap.add_argument("--cache-bust", action="store_true")
    args = ap.parse_args()

    raw_rows = load_jsonl(args.prompts, args.offset + args.limit)[args.offset : args.offset + args.limit]
    rows = [prepare_row(r, args.source_char_budget) for r in raw_rows]

    post_json(f"{args.kiln_url}/v1/adapters/unload", {}, timeout=120)
    results = []
    try:
        for i, row in enumerate(rows):
            salt = f"base-{args.adapter}-{args.seed + i}" if args.cache_bust else None
            text = generate(args.kiln_url, row, args.seed + i, args.max_tokens, args.temperature, salt)
            results.append({"prompt_index": args.offset + i, "adapter": "base", "score": score(row, text), "text": text})

        post_json(f"{args.kiln_url}/v1/adapters/load", {"name": args.adapter}, timeout=120)
        for i, row in enumerate(rows):
            salt = f"adapter-{args.adapter}-{args.seed + i}" if args.cache_bust else None
            text = generate(args.kiln_url, row, args.seed + i, args.max_tokens, args.temperature, salt)
            results.append({"prompt_index": args.offset + i, "adapter": args.adapter, "score": score(row, text), "text": text})
    finally:
        post_json(f"{args.kiln_url}/v1/adapters/unload", {}, timeout=120)

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = ROOT / "results" / f"{ts}-{args.adapter}-eval"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "eval.json").write_text(json.dumps({"adapter": args.adapter, "results": results}, indent=2))
    means = {}
    for name in sorted({r["adapter"] for r in results}):
        vals = [r["score"] for r in results if r["adapter"] == name]
        means[name] = sum(vals) / max(len(vals), 1)
    delta = means.get(args.adapter, 0.0) - means.get("base", 0.0)
    verdict = "improved" if delta > 0.02 else ("regressed" if delta < -0.02 else "flat")
    summary = {
        "adapter": args.adapter,
        "scorer": "scripts/score_compaction.py@v0.3",
        "prompts": str(args.prompts),
        "offset": args.offset,
        "limit": args.limit,
        "source_char_budget": args.source_char_budget,
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "seed": args.seed,
        "cache_bust": args.cache_bust,
        "means": means,
        "delta_vs_base": delta,
        "verdict": verdict,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    ledger = {
        "iter": None,
        "slug": f"{args.adapter}-eval",
        "ts": datetime.now(timezone.utc).isoformat(),
        "status": "completed",
        "score": means.get(args.adapter),
        "hypothesis": "Cache-busted held-out evaluation should detect whether the adapter improves Pi compaction reward over the base model.",
        "prompt_set": str(args.prompts),
        "scorer": "scripts/score_compaction.py@v0.3",
        "adapter": args.adapter,
        "eval": summary,
        "artifacts": [str(out_dir / "eval.json"), str(out_dir / "summary.json")],
        "verdict": verdict,
        "next_focus": "If improved, archive and compare on broader held-out prompts; if flat/regressed, adjust target data or reward before further chaining.",
    }
    with LEDGER.open("a") as f:
        f.write(json.dumps(ledger, ensure_ascii=False) + "\n")
    print(json.dumps({"out_dir": str(out_dir), "means": means}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
