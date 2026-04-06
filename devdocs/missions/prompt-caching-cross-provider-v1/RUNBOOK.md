1. Read `ARCHITECTURE.md`, `SPEC.md`, `TASKS.json`, `MILESTONES.json`, `PROGRESS.md`, and this `RUNBOOK.md` before starting each run.

2. Before the first implementation iteration and after any harness edit, run:
   - `node ~/.mu/agent/docs/scripts/mission-validator.mjs devdocs/missions/prompt-caching-cross-provider-v1`

3. Record baseline state in `PROGRESS.md`:
   - `git log --oneline -1`
   - `git status --short`
   - current behavior notes for prompt caching and replay verification.

4. Choose exactly one highest-priority task with status `todo`.

5. Set that task to `in_progress` when starting and back to `done` only after validation passes.

6. Default implementation loop per task:
   - write or update targeted failing verification
   - confirm red when appropriate
   - implement smallest change
   - run targeted verification
   - expand to adjacent verification
   - update `PROGRESS.md` and `TASKS.json`

7. Verification requirements:
   - prefer real-module imports over mocks
   - use `/tmp` scripts for prompt replay and payload projection
   - use real session files from `~/.mu/sessions` when validating cache stability
   - compare adjacent-turn provider payloads, stable-prefix hashes, and layer diffs

8. Provider rules:
   - keep the shared cache-plan abstraction canonical
   - `openai-completions`, `openai-responses`, and `anthropic` must all benefit
   - Anthropic `cache_control` is an optimization layer, not the core model

9. Compaction / mutation rules:
   - preserve oldest stable prefix bytes whenever possible
   - if history must be compacted or pruned, prefer newest-first mutation of eligible unstable content

10. Safety rules:
   - do not run destructive git commands
   - do not discard unrelated working tree changes
   - do not commit unless explicitly requested

11. Milestone gate tasks must not be marked done until all milestone verification items are green and evidence files exist.

12. Final completion requires:
   - milestone gates closed
   - replay evidence captured
   - `npm run check` passing
   - `PROGRESS.md` updated with final summary
