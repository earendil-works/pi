# NLT Coding Agent MVP

This directory is the application boundary for the first NLT Coding Agent MVP and the intended Vercel project root.

## Runtime foundation

The MVP consumes the checked-in `@earendil-works/pi-coding-agent` workspace at `packages/coding-agent`. The root npm workspace and lockfile make this source authoritative; the MVP does not independently install a potentially different registry release.

Run the repository install from the repository root. The MVP typecheck is included in the root `npm run check` command as `check:mvp`.

For a Vercel project using `mvp/` as its Root Directory, the project must also include source files outside that directory so the root workspace package at `packages/coding-agent` is available during installation and build. This PR documents that monorepo requirement; it does not change Vercel project settings or deploy anything.

## Ownership boundaries

- **MVP application:** user-facing application and request lifecycle.
- **`packages/coding-agent`:** agent runtime, SDK, sessions, and coding-agent capabilities.
- **ASFDK:** governance and authorization remain separate from model intent and tool availability.
- **AgentOS:** execution environment ("computer"), not an authority source.
- **Human:** final authority for consequential actions.

## Initial scope

This change establishes the package boundary and deterministic workspace dependency path only. It does not select a Vercel framework, configure deployment, expose tools, add authentication, choose persistence, or connect an external provider. Those decisions remain explicit follow-up work.

Do not expose coding-agent tools to requests until the ASFDK harness and execution boundary are integrated and verified. Do not treat this scaffold as a deployed or production-ready agent.

## Governed turn

`createNltCodingAgent()` exposes a deterministic governed turn surface (`governedTurn`) that runs a user prompt through the ASFDK harness before any coding-agent turn may execute:

- Crisis / emotional assessment (Sleepwalker Protocol + RRT Advocate handoff) via `harness.assessText`.
- Blocking crisis levels (`RED` / `BLACK`) or failed governance assessments return `allowed: false` with a `blockedReason` — escalation to a human precedes agent execution.
- Non-blocking assessments return `allowed: true` with the interaction, emotional state, governance, and continuity context needed to feed the subsequent coding-agent turn.

`runNltCodingTurn()` wraps the above into a single governed turn entry point: assess → block-or-run → inject governed system prompt (ASFDK protocol + preflight) → execute through the pi-coding-agent runtime (ASFDK extension loaded) → return the final assistant response plus post-turn governance/continuity bookkeeping.

The MVP does not yet persist continuity or run a separate post-turn response-governance pass; those remain explicit follow-up agent-side work.
