# Task: force Morph compaction everywhere

Goal:
- Make all compaction paths use Morph or fail clearly, while preserving mission-specific continuation semantics.

Current state:
- Morph is optional and selected via strategy; mission inter-iteration compaction uses a local synthetic checkpoint path.

Next step:
- Add/adjust red tests for forced Morph on explicit, auto, and mission compaction flows.

Verification:
- npm test -w @kennyfrc/mu-coding-agent -- morph-compaction-explicit.test.ts morph-compaction-auto.test.ts mission-compact-trigger-next-iteration.red.test.ts
- npm run check
