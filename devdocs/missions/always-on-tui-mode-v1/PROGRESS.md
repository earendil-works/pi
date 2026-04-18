# Progress

## Current status

- Mission scaffold created.
- Architecture checkpoint recorded and approved.
- All milestone gates are complete.
- All task statuses are `done`.

## Completed

- Captured the simplified architecture for `/always-on` TUI mode.
- Recorded the approved boundaries, abstractions, tradeoffs, and priorities.
- Defined milestone gates and evidence targets.
- Added `packages/coding-agent/test/always-on-service.red.test.ts` to define the missing shared service contract.
- Confirmed the red state with `npm test -w @kennyfrc/mu-coding-agent -- always-on-service.red.test.ts`; it fails on the missing `../src/always-on/service.js` module.
- Added `packages/coding-agent/src/always-on/service.ts` and refactored the CLI submission paths to delegate through it.
- Closed milestone `shared-service-layer` with targeted-test, review, assertion, and XTUI evidence.
- Added the `/always-on` and `/always-on-exit` TUI surface tests and implemented explicit always-on mode state in the renderer.
- Closed milestone `tui-mode-surface` with targeted-test, review, assertion, and XTUI evidence.
- Added the red harness for mode-aware plain-text submission and mode-scoped tool/prompt gating.
- Confirmed the red state with `npm test -w @kennyfrc/mu-coding-agent -- always-on-mode-submit.red.test.ts always-on-mode-tools.red.test.ts`; failures are the intended missing submission-routing and tool-refresh behavior.
- Implemented mode-aware plain-text always-on submission, primitive mode-scoped always-on tools, and pre-mode tool/prompt restoration.
- Closed milestone `mode-submission-and-tools` with targeted-test, review, assertion, XTUI, and adjacent-regression evidence.
- Added the red harness for always-on inspection, scheduling, and follow-up command flows.
- Confirmed the red state with `npm test -w @kennyfrc/mu-coding-agent -- always-on-mode-inspection.red.test.ts always-on-mode-schedule.red.test.ts always-on-mode-followup.red.test.ts`; the failures are the intended missing command-surface gaps.
- Implemented the always-on inspection, schedule, agent-selection, thread, and follow-up command surface in the TUI.
- Turned the milestone-4 targeted suites green and recorded adjacent regression evidence.
- Closed milestone `inspection-and-scheduling-surface` with targeted-test, review, XTUI, ledger-assertion, and adjacent-regression evidence.
- Passed the full repo validation with `npm run check` and completed the mission.

## Next step

- Mission complete.

## Notes

- Keep the append-only always-on ledgers authoritative.
- Keep TUI-owned state minimal.
- Prefer deep primitives over many subcommand-shaped helpers.
