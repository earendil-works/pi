Goal: Make /subscribe and /unsubscribe open selectors instead of submitting, listing recent sessions (last 24h) and active subscriptions.

Constraints:
- Keep subscription handling consistent with existing /subscribe flow.
- Avoid new uses of type any.
- Run npm run check after code changes.
- Test-driven slices (tests first).

Current state:
- Added subscription selection helper (filterRecentSubscriptionSessions) and tests.
- subscription-selection.test.ts passing.
- Added subscribe/unsubscribe selector component and selection helpers.
- TUI now intercepts /subscribe and /unsubscribe to open selectors and show empty-state messages.
- npm run check completed.

Slice: 2 / 2
Next step: Summarize changes and verification for the user.
