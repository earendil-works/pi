# Diverse prompt set v2

Built `data/trajectory-compaction-prompts-v2.jsonl` from eight explicit high-context sessions listed by `/data/apps/trajectory-trainer/scripts/materialize_turn.py`.

Changes:

- Added `--session-ids` support to `scripts/build_compaction_prompts.py` to avoid slow full-table ranking.
- Added read/modified file extraction from `Read`, `Grep`, `Glob`, `Edit`, `MultiEdit`, and `Write` tool-use records.
- Updated `heuristic_positive` to append Pi-compatible `<read-files>` and `<modified-files>` blocks when metadata is present.

Calibration with scorer `scripts/score_compaction.py@v0.3` and 1200-char source windows:

- rows: 8
- sessions: 8
- target mean: 0.7362
- target min: 0.7026
- target max: 0.7882

Verdict: v2 gives more diverse training/eval prompts and better file-operation fidelity than the original clustered prompt set. It is ready for the next clean BF16 GRPO attempt once A6000 capacity is available.
