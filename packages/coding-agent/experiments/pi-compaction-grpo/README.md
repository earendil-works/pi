# Pi Compaction GRPO Lab

Objective: build increasingly strong adapters for Pi context compaction.

This directory is intentionally resumable. Every run should leave enough state
for another agent to continue without guessing.

## Source Understanding

Pi compaction source read at `pi` commit `0f066367`.

Core behavior:

- `compaction.ts`
  - Computes trigger threshold with `contextTokens > contextWindow - reserveTokens`.
  - Estimates tokens from the latest valid assistant usage plus trailing heuristic tokens.
  - Finds valid cut points over current branch entries, never cutting at tool results.
  - Repeated compactions summarize from the prior `firstKeptEntryId` boundary so kept
    messages are not silently dropped across compactions.
  - If a single turn is too large, it creates a turn-prefix summary and appends it to
    the history summary under `Turn Context (split turn)`.
  - Summary generation serializes conversation text, passes prior summary when present,
    clamps output tokens to the model limit, and preserves the session thinking level.
  - File operations are accumulated from prior Pi-generated compaction details and
    current assistant tool calls, then appended as `<read-files>` and `<modified-files>`.

- `branch-summarization.ts`
  - Finds the common ancestor between old and target branches.
  - Summarizes the abandoned branch from common ancestor to old leaf.
  - Uses newest-first token budgeting for long branches, while still accumulating file
    operations from all branch-summary details in the branch being summarized.
  - Prepends a branch-summary preamble before the structured summary.

- `utils.ts`
  - Extracts read/write/edit tool calls only from assistant `toolCall` blocks with a
    string `path` argument.
  - Computes read-only vs modified file lists.
  - Serializes LLM messages as tagged plain text and truncates tool results to 2,000
    chars, leaving user/assistant content untruncated.

Important risks to train/evaluate against:

- Summaries that are valid Markdown but lose current objective, constraints, or state.
- Summaries that preserve old progress but miss the latest resume point.
- Summaries that hallucinate completed work or hide blockers.
- Summaries that omit exact file paths, commands, errors, adapter names, or metrics.
- Summaries that overfit the fixed headings while not encoding useful continuation state.
- Summaries that exploit length/compression scoring by becoming too short.
- Summaries that include stale or duplicated file-operation lists.

## Experiment Discipline

Inspired by the OPD/SFT capability-creator skills:

- Hypothesis before data.
- Scorer/rubric before GRPO.
- Append-only `experiments/ledger.jsonl`.
- Every row records prompt set, scorer version, adapter artifact, scores, verdict,
  regressions, B2 prefix, and next focus.
- Calibration cases must keep good summaries high and bad summaries low before using
  a scorer version for training.

## B2

Private sync target:

`b2://clouderic/pi-compaction-grpo/`

Use:

```bash
./scripts/sync_b2.sh
```

