Scorer v0.2 calibration and replay notes.

Changes:
- Added exact Pi-heading preference from `packages/coding-agent/src/core/compaction/compaction.ts`.
- Added entity precision and unsupported-entity penalties to reduce entity stuffing.
- Added blocker fidelity so failed/OOM/no-adapter state cannot become "no blockers".
- Added actionability scoring for concrete ordered next steps.
- Added conversation-continuation penalties for outputs that answer the transcript instead of summarizing it.
- Tightened file-operation penalties when expected read/modified paths are missing from Pi XML tags.

Calibration:
- `calibration/good.jsonl` / `pi_compaction_operational_good`: `0.8269`
- `calibration/bad.jsonl` / `generic_heading_only`: `0.2822`
- `calibration/bad.jsonl` / `hallucinated_completion`: `0.1630`

Replay on recent non-thinking samples:
- v006 old mean `0.6217`, v0.2 replay mean `0.6635`.
- v007 old mean `0.6096`, v0.2 replay mean `0.6819`.

Interpretation:
The v0.2 scorer still gives useful contrast, but it shifts reward toward concrete next-step/actionable summaries and away from heading-only or unsupported-entity shortcuts. This is the reward to use for the next clean-pod GRPO attempt.
