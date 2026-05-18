# Rubric Source Contract Refresh

## Status
- Rechecked local Pi compaction source at `/workspace/pi` commit `0f066367bf0ccae1f0762856be351829e03760b3`.
- Verified the live GitHub compaction directory on `main` still contains the expected compaction files.
- Updated `rubric.md` to align the documented subscore weights with `scripts/score_compaction.py@v0.3`.
- Added explicit Pi source-contract notes for:
  - exact compaction headings
  - previous-summary update behavior
  - split-turn `Turn Context`
  - `<read-files>` / `<modified-files>`
  - branch-summary heading differences
  - inert transcript serialization and tool-result truncation

## Verification
- `python3 scripts/test_compaction_quality.py`: 5 tests passed.
- `python3 scripts/calibrate_scorer.py`: calibration gates passed.
