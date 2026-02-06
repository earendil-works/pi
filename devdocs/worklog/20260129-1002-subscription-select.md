Slice 1 / Iteration 1 of 2
- Pending: add subscription selection helper + tests.
- Verification to run: npm test -w @kennyfrc/mu-coding-agent -- subscription-selection.test.ts.
- Added packages/coding-agent/src/subscriptions/subscription-selection.ts.
- Added packages/coding-agent/test/subscription-selection.test.ts.
- Ran: npm test -w @kennyfrc/mu-coding-agent -- subscription-selection.test.ts (pass).

Slice 2 / Iteration 2 of 2
- Pending: add unsubscribe options helper + TUI selector wiring; run npm test -w @kennyfrc/mu-coding-agent -- subscription-selection.test.ts && npm run check.
- Added buildSubscribeSelectItems/buildUnsubscribeSelectItems helpers in subscription-selection.ts.
- Added packages/coding-agent/src/tui/subscription-selector.ts and wired selectors in tui-renderer.ts.
- Updated subscription-selection.test.ts for selection item helpers.
- Ran: npm test -w @kennyfrc/mu-coding-agent -- subscription-selection.test.ts (pass).
- Ran: npm run check (pass; biome fixed 1 file).
