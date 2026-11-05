# NLT-Pi Intent Record

**Date:** 2026-11-05T22:00:00+00:00  
**Agent / session:** Claude (Claude Code) / `session_01UNjnjkGsveT9DW8pC9UXhf`  
**Branch:** `ccr-50842984-chat-history`  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Implement chat history in Neon, following the owner-approved spec `docs/superpowers/specs/2026-11-05-chat-history-neon-design.md`:

1. A store over `@neondatabase/serverless` (pinned) with two tables, `chat_conversations` and `chat_messages`.
2. An owner-only `/api/conversations` (list, open, save, delete), off unless `NLT_HISTORY_ENABLED=1`.
3. Chat-page wiring: the sidebar loads saved conversations, exchanges are saved with a retry, and delete asks for confirmation. The data notice changes when history is on.

## Rationale
The owner added Neon to the Vercel project and chose chat history as its first use. Today conversations last only as long as the open tab.

## Risks and trust boundaries
- **New persistence boundary.** Conversation text is stored in the owner's Neon database. The owner decided this in session (2026-11-05), and it is off by default.
- **Owner isolation.** The owner is taken from the signed session cookie only. Every SQL statement is parameterised and filtered by `owner_sub`.
- **Blocked messages.** A message the ASFDK gate blocks is stored with an empty text, and the route enforces this.
- **Failure.** A database failure answers 503 and logs only the operation name. `/api/agent` and `/api/govern` are unchanged, so chat works without Neon.
- **Not done:** no Mem0, and no conversation context given to the model. The agent still answers each message on its own. No Neon Auth and no Neon realtime.
- **New dependency.** `@neondatabase/serverless` 1.2.0, with no runtime dependencies, pinned and audited.

## Rollback
Unset `NLT_HISTORY_ENABLED` (the page behaves as before), or revert the PR. Tables left in Neon can be dropped in the Neon console.
