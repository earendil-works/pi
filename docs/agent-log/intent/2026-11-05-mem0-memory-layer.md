# NLT-Pi Intent Record

**Date:** 2026-11-05
**Agent / session:** Claude (Cline)
**Branch:** main (working tree)
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action

Implement the Mem0 memory layer (phase 1), following the owner-approved spec `docs/superpowers/specs/2026-11-05-mem0-memory-layer-design.md`:

1. `src/memory/client.ts` — Mem0 REST client over `fetch`, server side only. `MEM0_API_KEY`, `MEM0_BASE_URL` etc. from env; never in the browser or sandbox.
2. `src/memory/store.ts` — `MemoryStore` abstraction with a fake in-memory implementation for tests and a Mem0 wrapper for production.
3. `src/memory/route.ts` — Testable owner-only route (GET list, POST save, DELETE delete), off unless `NLT_MEMORY_ENABLED=1`, 401 without owner session, `Cache-Control: no-store`. ASFDK checks (`validateInputLength`, `sanitizeInput`, `detectInjectionPatterns`) on every write; source-message rule against Neon.
4. `api/memories.ts` — Vercel handler wiring the route to Mem0 and the Neon source-message check.
5. `src/agent/runner.ts` — Recall after the crisis gate: search Mem0, filter through recall checks, inject as delimited untrusted background before the model runs. Turn writes nothing to Mem0.
6. `public/app.js`, `public/app.css`, `public/index.html` — "Remember this" button on user messages, Memories panel (list/delete), data notice when memory is on.
7. `mvp/README.md` — Memory section and Mem0 row in the platforms table.
8. `test/memory-route.test.ts` — 23 route tests (vitest), all offline, no Mem0 calls.

## Rationale

The owner agreed the Mem0 design on 2026-11-05. The agent stops forgetting between conversations: owner-approved facts are saved as memories and recalled in later conversations.

## Risks and trust boundaries

- **New third-party processor.** Mem0 is a new external integration. The owner consents via `NLT_MEMORY_ENABLED=1`. The chat page's data notice says prompts are sent to Mem0 on every turn when memory is on.
- **New persistence boundary.** Learned facts persist in Mem0. The owner controls what is saved ("Remember this" is explicit per message) and can delete any memory.
- **Owner isolation.** The owner comes from the signed session cookie only, never from the request body. Every Mem0 operation is scoped to `user_id = owner` and `agent_id = nlt-pi-mvp`.
- **No model-driven change.** No code reachable from `runAgentTurn` imports the Mem0 client or an owner-route handler. The model gets no Mem0 tool. The crisis gate runs before any Mem0 call, so a blocked prompt is never sent as a search query.
- **Fail closed.** Every Mem0 read and write passes ASFDK deterministic checks. A missing or erroring check counts as a block. A blocked or unavailable source message is refused.
- **No code, secrets or governance content.** Memories are short, specific facts only.
- **New dependency.** None — the client uses `fetch` against the Mem0 REST API with the existing `MEM0_*` settings. No new npm package.
- **Not verified offline: real Mem0 behaviour.** Probe items (a)–(e) in the spec must be recorded before enabling the switch in Production.

## Rollback

Unset `NLT_MEMORY_ENABLED` (the page behaves as before), or revert the PR. No data is written unless the owner sets the switch and approves each memory.