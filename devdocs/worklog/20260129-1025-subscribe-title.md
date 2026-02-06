Slice 1 / Iteration 1 of 2
- Added title parsing to SessionManager session summaries and exposed optional title fields.
- Updated subscription-selection label helper to prefer title and strip <user_message_time> tags.
- Updated subscription-selection tests for title preference and timestamp stripping.
- Ran: npm test -w @kennyfrc/mu-coding-agent -- subscription-selection.test.ts (pass).
- Ran: npm run check (pass).

Slice 2 / Iteration 1 of 2
- Wired session titles into subscribe/unsubscribe summaries in TuiRenderer.
- Ran: npm run check (pass).
