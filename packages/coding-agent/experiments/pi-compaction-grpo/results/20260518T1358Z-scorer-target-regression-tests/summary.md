# Scorer and Target Regression Tests

## Status
- Added `scripts/test_compaction_quality.py`.
- Ran `python3 scripts/test_compaction_quality.py`.
- Result: 5 tests passed.

## Coverage
- Good calibration rows must stay at or above `0.75`.
- Bad calibration rows must stay at or below `0.35`.
- Malformed/encoded non-Pi headings must trigger `malformed_or_encoded_output` and `missing_exact_pi_headings` penalties.
- The v3 outlier session must not use `<task-notification>` / `<tool-use-id>` as the goal.
- The v3 outlier session must not leak XML tag pseudo-paths into Critical Context.
- All v3 heuristic targets must keep min score >= `0.72` and mean score >= `0.77` under scorer v0.3.

## Infra
- A bounded A6000 acquire attempt for `pi-compaction-grpo-v025` still failed with the retryable RunPod capacity error.
