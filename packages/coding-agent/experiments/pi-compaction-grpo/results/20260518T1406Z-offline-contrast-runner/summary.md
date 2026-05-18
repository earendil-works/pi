# Offline Contrast Runner

## Status
- Added `--offline-contrast` to `scripts/run_compaction_contrast_iteration.py`.
- Added `--dry-run` so GRPO groups can be built and scored locally without a Kiln server.
- Added a controlled generic negative completion for each prompt.
- Added budget-aware heuristic positives so completion budgets reduce detail structurally instead of raw truncating text.
- Fixed future dry-run ledger rows to use `status: dry_run`.

## Dry Runs
- v028, completion budget 900 before budget-aware positive:
  - negatives: `0.3787`, `0.5501`
  - positives: `0.4802`, `0.5951`
  - verdict: too weak; raw truncation and high-scoring negatives reduce contrast.
- v029/v030, completion budget 900 after weaker negative and compact positive:
  - v030 negatives: `0.2007`, `0.3767`
  - v030 positives: `0.5390`, `0.5989`
  - verdict: usable contrast but positives still lose too much detail at 900 chars.
- v031, completion budget 1200:
  - negatives: `0.2007`, `0.3767`
  - positives: `0.6936`, `0.7496`
  - verdict: best offline payload so far; try on a clean larger-memory pod first, or A6000 if 1200/1200 fits.

## Verification
- `python3 scripts/test_compaction_quality.py`: 5 tests passed.
- `python3 scripts/calibrate_scorer.py`: calibration gates passed.
