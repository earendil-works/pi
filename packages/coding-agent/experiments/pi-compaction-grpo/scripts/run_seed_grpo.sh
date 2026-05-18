#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KILN_URL="${KILN_URL:-http://127.0.0.1:8420}"
ADAPTER="${1:-pi-compaction-seed-v001}"
KILN_BIN="${KILN_BIN:-kiln}"

cd "$ROOT"

python3 scripts/calibrate_scorer.py
python3 scripts/build_seed_grpo.py

"$KILN_BIN" train grpo \
  --url "$KILN_URL" \
  --file "$ROOT/data/seed-grpo-groups.jsonl" \
  --adapter "$ADAPTER" \
  --lora-rank 16

