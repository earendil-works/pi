# NLT-Pi Intent Record

**Date:** 2026-11-06T04:54:00Z
**Agent / session:** kilo (Glyph Cluster) / `workspace_9fff0f4d-6640-455f-8e8a-44fbaf73e538`
**Branch:** `kilo/real-crest-lik`
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Implement the owner-approved sandbox access requests design (`docs/superpowers/specs/2026-11-06-sandbox-access-requests-design.md`, nlt-pi#39, owner approval 2026-11-06). Files/components affected (under `mvp/` unless noted):
- `src/access/store.ts` — Neon `access_requests`/`network_grants` store (owner-scoped, atomic nonce consume, pending cap/cleanup).
- `src/access/route.ts` + `api/access.ts` — owner-only GET/POST/DELETE for decisions and allowed-sites list; off unless `NLT_ACCESS_REQUESTS=1`.
- `src/access/tool.ts` (or integrated tool) — `request_network_access` tool registered only when feature on, DB set, egress not allow-all, and `conversationId` present; validates host/reason, records pending request bound to conversation+task hash, signals turn end.
- `src/agent/runner.ts`, `src/agent/route.ts`, `api/agent.ts` — `conversationId`/`resume` handling; load grants+validated resume hosts after gate and before sandbox; pass `needs_access` result and extra egress hosts; register access tool conditionally; log `access_*` events without prompt/reason/nonce/content.
- `src/sandbox/lifecycle.ts` — no behavior change beyond consuming composed egress (already supports `egressAllow`).
- `public/app.js`, `public/index.html`, `public/app.css` — needs_access cards, continuation turns with nonce held in memory only, allowed-sites list; info messages not saved as chat history.
- `mvp/README.md` — Network paragraph/platform table update.
- `test/access-*.test.ts`, updates to agent route/runner tests — offline tests and mutation-focused checks per spec §9.
- `docs/active-threads.md`, handoff record — update NLTPI-MVP-007 and add implementation handoff.

## Rationale
Owner approved the revised spec and directed implementation. The feature lets the sandbox reach non-preset hosts only with explicit signed-in owner authorization, bound to the originating conversation/task and (for one turn) a one-time nonce.

## Risks and trust boundaries
- **Sandbox egress boundary (security-sensitive):** approved host can receive workspace contents; sandbox holds no credentials (stated on card/README). `NLT_AGENT_EGRESS_ALL=1` unchanged/overrides.
- **Authority:** grants exist only from signed-in owner decisions via owner-only routes; browser never sends host for decisions; resume carries ids/nonce/task, never hosts. Model output/tool calls never authorize.
- **Prompt injection/exfiltration:** owner sees exact host and warning; always-allowed hosts listed/removable.
- **Replay/binding:** allow_turn bound to owner+conversation+task hash+nonce hash, consumed by one atomic UPDATE, short expiry; resume requires prompt to begin with task.
- **Fail closed:** lookup/validation errors mean presets only (`access_lookup_error`); feature off = unchanged; malformed input 400; no nonce/prompt/reason/workspace content in logs/stream/GET.
- **New persistence:** two Neon tables, owner-scoped, created on first use; no new provider/dependency.
- **Layering:** AgentOS execution/egress with owner authorization; sandbox enforces server-computed policy; ASFDK crisis gate still runs before lookup; no changes to ASFDK foundation/harness/MCP layers.

## Alternatives considered
- Pause turn mid-run (rejected in spec): holds sandbox lock and budget, needs polling.
- Browser-sent host for decisions (rejected): host must be looked up server-side.

## Human approval / escalation
Owner explicitly approved the spec and directed implementation (2026-11-06, this session). No further approval required for scoped implementation; escalate if live sandbox mid-session network-policy behavior blocks verification or if a governance/authority boundary change beyond the approved spec is needed.

## Outcome
[Complete after execution. Record actual result and deviations.]
