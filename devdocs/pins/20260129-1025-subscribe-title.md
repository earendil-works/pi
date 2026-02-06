Goal: Improve /subscribe and /unsubscribe selector labels by using session titles (when available) and stripping user_message_time tags from first messages.

Constraints:
- Keep subscription selection consistent with existing /subscribe flow.
- Avoid introducing new uses of type any.
- Run npm run check after code changes.
- Leave unrelated selectors unchanged.
- Do not discard existing uncommitted work.

Current state:
- SessionManager summaries now parse title/title_change entries and expose optional title values.
- Subscription selection labels prefer title, otherwise strip <user_message_time> tags from firstMessage.
- subscription-selection tests updated for title + timestamp stripping.
- TuiRenderer now passes title into subscribe/unsubscribe session summaries.
- npm run check passes.

Slices:
1) Add title to session summaries and update subscription-selection label logic/tests.
   - Verify: npm test -w @kennyfrc/mu-coding-agent -- subscription-selection.test.ts
2) Wire title through TuiRenderer subscription summaries; run npm run check. (done)

Slice: 2 / 2
Next step: Report completion.
