1. Read `devdocs/missions/spec-mode-v1/SPEC.md`, `ARCHITECTURE.md`, `TASKS.json`, `MILESTONES.json`, `PROGRESS.md`, `VERIFIER_GUIDE.md`, and `RUNBOOK.md` and treat them as the source of truth.

2. Before the first iteration, run `node ~/.mu/agent/docs/scripts/mission-validator.mjs devdocs/missions/spec-mode-v1` and fix any harness errors.

3. Record the current baseline:
   - `git log --oneline -1` to note the starting commit
   - `git status` to see current working tree state
   - Document in PROGRESS.md

4. Run baseline validation:
   - npm run check
   - npm test -w @kennyfrc/mu-coding-agent
   - Record results in PROGRESS.md

5. Choose exactly one highest-priority task with status `todo`.

6. Set the task status in `TASKS.json` to `in_progress` when you start work.

7. Make the smallest scoped change needed to complete the task.
   - Prefer selective edits over broad changes
   - Do not modify unrelated files
   - Do not run destructive commands like `git checkout -- .` or `git reset --hard`

8. Extension-first approach:
   - Core changes minimal: only in packages/coding-agent/src/extensions/ (types.ts, manager.ts)
   - Implementation lives in `~/.mu/agent/extensions/spec-mode/`
   - No business logic in core packages
   - Acknowledge real integration: TuiRenderer for commands, FooterComponent for indicators

9. Run the task's validation commands.
   - If a command fails, investigate and fix without reverting unrelated changes
   - Use selective edits, not broad reverts

10. If the current task is a milestone acceptance gate (reload-verification or final-acceptance-gate):
    - Run the milestone verification criteria from `MILESTONES.json`
    - For review verifications, follow `VERIFIER_GUIDE.md` explicitly
    - Do not mark the gate task `done` unless the milestone is actually green
    - For reload verification: test extension reload restores state
    - For final milestone: verify all tests pass and npm run check is green

11. Apply the decision rule:
    - **keep**: validation passes, implementation is correct
    - **discard** (rare): approach is fundamentally wrong, but prefer fixing forward
    - **blocked**: cannot continue without external info/access (rare)

12. Treat `blocked` as rare and external-only. If validation fails but you can investigate, edit, test, or add fix tasks, you are not blocked.

13. Update `TASKS.json` and `PROGRESS.md` with:
    - final task status
    - what changed (files modified, lines added/removed)
    - what was verified (test results, log evidence)
    - next recommended task
    - any deviations from planned approach and why

14. Do not work on more than one task in this run.

15. Leave the repository in a working state:
    - Prefer `git add -p` for selective staging
    - Do not discard unrelated changes
    - Working tree should have only intentional mission-related changes

16. When all tasks are done, run final validation and mark mission complete.

## Extension-First Reminders

- Extension path: `~/.mu/agent/extensions/spec-mode/` (NOT `~/.mu/extensions/`)
- Use existing primitives: `registerCommand`, `context` hook, NOT new abstractions
- State storage: `getExtensionState`/`setExtensionState`, NOT AgentState
- Visual feedback: `api.print()` for confirmation + optional `registerExtensionIndicator` for footer
- Real integration: TuiRenderer renders commands, FooterComponent renders indicators
- Test edge cases: reload, multiple extensions, streaming mode change, verifier failure

## Safety Reminders

- Never run `git checkout -- .` or `git reset --hard`
- Never discard unrelated working tree changes
- Use selective, targeted edits
- If stuck, add a task to fix the specific issue rather than reverting everything
