# Plan: [pre-commit-gate] You were about to start a new session, but there are uncommitted changes. Before switching:

1. Review all uncommitted changes — run `git diff` to see what's pending.

2. Use the subagent tool in parallel mode to fix issues:
- reviewer agent with mode "tdd" — check TDD compliance, fix violations

3. Then run a final security audit:
- sentinel agent with mode "diff" — security audit on final changes (read-only)
   If sentinel reports P0 findings, fix them yourself.

4. Write a brief session summary to `CHANGELOG.md` (append to top under today's date):
   - What was built/changed (features, fixes, refactors)
   - Files modified (key ones, not every file)
   - Issues found and fixed by the quality gate
   - Any remaining TODOs or known issues
   Keep it concise — 5-15 lines max. Use markdown list format.

5. Write detailed task documentation in `docs/tasks/backend/`:
   - Create a markdown file named after the task/feature (e.g. `docs/tasks/frontend/add-dark-mode-toggle.md`)
   - Include: **Goal** (what was built and why), **Approach** (how it was implemented), **Files Changed** (with brief description of each change), **Testing** (how to verify), **Notes** (edge cases, decisions, trade-offs)
   - Categorize: .tsx/.jsx/.css changes go under `docs/tasks/frontend/`, .ts/.js backend logic goes under `docs/tasks/backend/`
   - If changes span both frontend and backend, create a doc in each category or pick the primary one.

6. When done, say "GATE_COMPLETE" so the system can commit and start a new session.

**Date:** 2026-03-16

## Plan Generated: install-pi-rewind

**Key Decisions Made:**
- Use `pi install npm:pi-rewind` (the recommended npm method, not git clone)
- Install as a pi extension, NOT as a dependency of the pi-mono project

**Scope:**
- IN: Install pi-rewind extension, verify it loads
- OUT: Configuration (none needed), source code changes, dev mode setup

**Guardrails Applied:**
- Must not add to pi-mono's `package.json` — this is an extension install, not a workspace dependency
- Must not clone the repo — use the npm package

**Defaults Applied:**
- Install method: `pi install npm:pi-rewind` (per README recommendation)

**Decisions Needed:** None — this is a 1-command install.

Plan saved to: `.pi/plans/install-pi-rewind.md`

**To execute:** Run `pi install npm:pi-rewind` and you're done. The extension is zero-config — it auto-detects git repos and starts creating checkpoints immediately on next session. You'll see `◆ X checkpoints` in the footer and can use `/rewind` or `Esc+Esc` anytime.
