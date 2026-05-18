# Pi Compaction Reward Rubric v0.3

The reward function grades a candidate summary against the source conversation
and optional reference metadata. It is designed as a GRPO reward, not just a
report-card. The highest score should require a summary that makes the next
agent effective after Pi discards older messages.

## Subscores

Weights sum to 1.0 before penalties.

| Subscore | Weight | Purpose |
| --- | ---: | --- |
| Goal and intent | 0.14 | Captures what the user wants, including broad objective and current concrete task. |
| Constraints and preferences | 0.10 | Preserves non-negotiables, safety constraints, style preferences, dates, budgets, and process rules. |
| Progress state | 0.15 | Separates done, in-progress, blocked, and failed work without fabricating completion. |
| Next actions | 0.12 | Gives ordered, actionable continuation steps grounded in current state. |
| Critical entities | 0.12 | Keeps exact file paths, commands, error strings, URLs, adapter names, metrics, IDs, and dates. |
| Entity precision | 0.05 | Penalizes unsupported concrete paths/IDs/commands so entity stuffing does not win cheaply. |
| File operations | 0.08 | Preserves read-only and modified file lists accurately when present. |
| Blocker fidelity | 0.06 | Carries failed/OOM/blocked/no-adapter state forward instead of falsely unblocking. |
| Actionability | 0.06 | Rewards ordered, concrete, command/path-aware continuation steps. |
| Recency | 0.06 | Prioritizes the latest unresolved work over stale earlier context. |
| Structure | 0.05 | Uses Pi-compatible headings and parseable sections. |
| Compression | 0.01 | Concise enough to save context, but not so terse that state is lost. |

v0.2 scorer implementation weights are slightly redistributed to add explicit
anti-shortcut checks:

- `entity_precision`: concrete IDs/paths in the candidate should be supported by
  the source or expected metadata, so entity stuffing does not win cheaply.
- `blocker_fidelity`: active blockers, failed jobs, OOMs, and "no adapter yet"
  state must not become "none".
- `actionability`: Next Steps should include ordered, concrete, command/path-aware
  actions rather than generic "continue".
- `structure`: exact Pi headings are preferred over merely plausible markdown.
- `compression`: kept as a small weight; length should not dominate content.

v0.3 adds anti-Goodhart penalties discovered during cache-busted adapter eval:

- `missing_exact_pi_headings`: Pi compaction expects exact `## Goal`,
  `## Constraints & Preferences`, `## Progress`, `## Key Decisions`,
  `## Next Steps`, and `## Critical Context` headings. Plain `Goal` or
  `### Goal` can still preserve information, but should not score as a
  production-quality Pi checkpoint.
- `malformed_or_encoded_output`: Tokenizer-noise headers such as
  `# Pi'.+-67`, URL-encoded `%20`, HTML entities, or punctuation/number junk
  near the top are penalized even if the rest of the text contains plausible
  entities.
- Cache-busted evaluation is required for adapter comparisons because prior
  same-prompt base-then-adapter evals could reuse cached completions and report
  identical outputs.

## Pi Source Contract

The scorer and target generator are grounded in
`/workspace/pi/packages/coding-agent/src/core/compaction/*` at commit
`0f066367bf0ccae1f0762856be351829e03760b3`.

- `compaction.ts` asks normal compaction summaries to use exact headings:
  `## Goal`, `## Constraints & Preferences`, `## Progress`, `## Key Decisions`,
  `## Next Steps`, and `## Critical Context`.
- repeated compaction uses `<previous-summary>` and must preserve/update prior
  goals, constraints, progress, decisions, next steps, and context instead of
  replacing them with only new tail information.
- split turns append `---` and `**Turn Context (split turn):**` with `## Original
  Request`, `## Early Progress`, and `## Context for Suffix`; summaries must not
  lose that prefix context when the suffix remains in the live session.
- file operations are appended after the summary in `<read-files>` and
  `<modified-files>` blocks; read-only files exclude files that were later
  modified.
- branch summaries use the same core state headings but are allowed to omit
  `## Critical Context`; they still append file-operation XML when present.
- `utils.ts` serializes the conversation as inert transcript text and truncates
  tool results. A high-scoring summary should summarize state, not continue or
  answer the serialized conversation.

## Penalties

- Hallucinated completion: up to -0.20.
- Contradiction of source facts: up to -0.20.
- Missing active blocker or uncertainty: up to -0.12.
- Empty/generic summary: up to -0.30.
- Copying too much source text with poor compression: up to -0.12.
- Heading-only compliance with no operational detail: up to -0.16.

## Anti-Shortcut Review

Cheapest bad paths and blockers:

- **Format-only summary**: structure score is capped at 0.06, and generic text triggers
  the empty/generic penalty.
- **Ultra-short summary**: compression can score well only inside a length band, while
  goal/progress/entity subscores fail.
- **Entity stuffing**: critical-entity score is capped unless progress and next-action
  scores are non-trivial; unsupported concrete entities add a penalty.
- **File-list stuffing**: file-operation score checks read/modified precision and recall.
- **Over-copying transcript**: compression penalty and structure score push toward a
  checkpoint summary instead of pasted source.
- **Conversation continuation**: assistant/user transcript-style continuations and
  "I can help" responses are penalized because Pi wants only a checkpoint summary.
- **False unblock**: a source with failed/OOM/blocked/no-adapter state must carry
  that uncertainty forward.

## Calibration Gate

Before using a scorer revision for training:

- `calibration/good.jsonl` cases should score at least `0.75`.
- `calibration/bad.jsonl` cases should score at most `0.35`.
- A deliberately generic but well-structured summary must score below `0.45`.

Current v0.3 calibration:

- good operational checkpoint: `0.8269`
- generic heading-only checkpoint: `0.2822`
- hallucinated completion checkpoint: `0.1630`
- malformed cache-busted eval examples that previously scored around
  `0.48-0.60` now score around `0.16-0.36` depending on retained content.
