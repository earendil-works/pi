# NLT-Pi Intent Record

**Date:** 2026-11-06T04:05:00+00:00  
**Agent / session:** Claude (Claude Code) / `session_01UNjnjkGsveT9DW8pC9UXhf`  
**Branch:** `ccr-50842984-network-access`  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Write and revise the design for letting the sandboxed coding agent ask the owner before reaching a site outside the npm, PyPI and GitHub presets: `docs/superpowers/specs/2026-11-06-sandbox-access-requests-design.md`. This record covers the design only. No code is written, and no implementation starts until the owner approves the spec and a plan.

The intent that the later implementation will carry out (recorded here because it changes a trust boundary, and a fresh intent record is added before any code):

1. A tool `request_network_access(host, reason)` that records a request and ends the turn.
2. An owner-only `/api/access` that turns a click into a grant: "allow for this turn" (bound to the originating conversation, task and a one-time nonce) or "always allow" (a stored, removable host).
3. A per-turn egress policy of presets, the owner's always-allowed hosts and valid turn grants.
4. Chat-page cards for the owner's decision.

## Rationale
The owner decided on 2026-11-06 to replace the fixed allow-list as the main control with a question to the owner, while keeping npm, PyPI and GitHub open. The owner chose a design in which a request ends the turn and resumes in a new one, so no turn waits for a click.

## Risks and trust boundaries
- **Sandbox egress boundary.** An approved host can receive anything in the sandbox workspace. The sandbox holds no credentials, so that is the exposure; the card states it.
- **Authority.** A grant exists only because the signed-in owner chose it. Model output proposes a host; it never authorizes one. The browser sends request ids, a nonce and the original task, never a host.
- **Prompt injection.** Content the agent reads can steer it to ask for an attacker's host. The owner sees the exact host first; always-allowed hosts are listed and removable.
- **Replay.** A "this turn" approval is bound to one conversation, one task and a nonce, consumed in one atomic statement (added after the owner's review of nlt-pi#39).
- **Fail closed.** Any failure loading grants leaves the presets. The feature is off unless the owner sets `NLT_ACCESS_REQUESTS=1`. `NLT_AGENT_EGRESS_ALL=1` is unchanged.
- **New persistence.** Two Neon tables in the existing project, owner-scoped. No new provider or dependency.
- **Layering.** AgentOS execution and egress with owner authorization. The sandbox enforces a policy the server computes; it is not an authorization authority. The ASFDK crisis gate still runs before any lookup.

## Outcome
Spec written and revised once after the owner's review (changes requested on nlt-pi#39: bind turn approvals to the originating task, define pending-request capacity, add governance records). Awaiting the owner's re-review.

## Rollback
Close nlt-pi#39. Nothing is deployed from this change.
