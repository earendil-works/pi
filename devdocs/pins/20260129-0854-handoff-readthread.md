# Pin: 20260129-0854-handoff-readthread

## Goal
Update handoff messaging to reference ReadThread, and ensure file contexts are wrapped in <file_context> tags.

## Spec/Context Brief
- Done means: handoff-related messages/tests reference ReadThread (not read_thread) and buildHandoffMessage guarantees file contexts are wrapped in <file_context> tags.
- Constraints: keep changes tight, avoid any, run npm run check after code changes.
- Unknowns: confirm if any non-handoff references should remain unchanged.

## Plan Brief
- Update formatParentThreadReference and related tests to say ReadThread.
- Ensure buildHandoffMessage wraps raw file context in <file_context> tags when missing.
- Update handoff tests for new behavior.

## Current State
- Slice 1 / Iteration 1 of 1 complete: handoff formatting/tests updated and checks/builds pass. Version bumped to 0.23.1.

## Next Step
- None (changes committed and package linked).

## Verification
- npm test --workspace @kennyfrc/mu-coding-agent -- handoff.test.ts
- npm run check
