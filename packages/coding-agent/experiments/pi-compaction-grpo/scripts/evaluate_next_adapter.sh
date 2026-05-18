#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

KILN_URL="${KILN_URL:-http://127.0.0.1:8420}"
ADAPTER="${ADAPTER:-pi-compaction-grpo-v035-f349-bf16-v03-v3-offset2-offline}"

python3 scripts/evaluate_adapter.py \
  --kiln-url "$KILN_URL" \
  --adapter "$ADAPTER" \
  --prompts data/trajectory-compaction-prompts-v3.jsonl \
  --offset 9 \
  --limit 3 \
  --source-char-budget 1200 \
  --max-tokens 220 \
  --temperature 0.7 \
  --seed 18051877 \
  --cache-bust
