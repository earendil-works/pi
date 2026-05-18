#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

KILN_URL="${KILN_URL:-http://127.0.0.1:8420}"
ADAPTER="${ADAPTER:-pi-compaction-grpo-v035-f349-bf16-v03-v3-offset2-offline}"
COMPLETION_BUDGET="${COMPLETION_BUDGET:-1200}"

python3 scripts/run_compaction_contrast_iteration.py \
  --kiln-url "$KILN_URL" \
  --prompts data/trajectory-compaction-prompts-v3.jsonl \
  --offset 2 \
  --limit 1 \
  --adapter "$ADAPTER" \
  --source-char-budget 1200 \
  --completion-char-budget "$COMPLETION_BUDGET" \
  --lora-rank 4 \
  --learning-rate 1e-5 \
  --max-tokens 120 \
  --offline-contrast \
  --no-auto-load \
  --wait
