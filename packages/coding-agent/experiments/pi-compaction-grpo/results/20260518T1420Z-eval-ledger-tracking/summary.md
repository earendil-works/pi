# Eval Ledger Tracking

## Status
- Updated `scripts/evaluate_adapter.py` so completed evals append a ledger row.
- Eval summaries now include:
  - prompt set
  - offset and limit
  - source budget
  - generation settings
  - cache-bust flag
  - base/adapter means
  - delta vs base
  - verdict: `improved`, `flat`, or `regressed`

## Verification
- `python3 -m py_compile scripts/evaluate_adapter.py`
- `bash -n scripts/evaluate_next_adapter.sh`
- `python3 scripts/test_compaction_quality.py`: 5 tests passed.

## Infra
- Latest A6000 acquire attempt `pi-compaction-grpo-v039` still failed with RunPod's retryable no-capacity error.
