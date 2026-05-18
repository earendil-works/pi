# Next Adapter Eval Wrapper

## Status
- Added `scripts/evaluate_next_adapter.sh`.
- It evaluates the staged next adapter with:
  - v3 prompts
  - held-out offset `9`
  - limit `3`
  - source budget `1200`
  - max tokens `220`
  - non-thinking generation
  - `--cache-bust`

## Verification
- `bash -n scripts/evaluate_next_adapter.sh`
- `python3 scripts/test_compaction_quality.py`: 5 tests passed.

## Use
- After `scripts/run_next_clean_grpo.sh` completes and the adapter is archived, run `scripts/evaluate_next_adapter.sh`.
- Keep using cache-busted eval only for model comparisons.
