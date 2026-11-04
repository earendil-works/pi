# NLT Coding Agent MVP

This directory is the application boundary for the first NLT Coding Agent MVP and the configured Vercel project root.

## Vercel application shell

The initial Vercel surface is a read-only status application:

- `public/index.html` provides the accessible, responsive status UI.
- `api/health.js` reports application-function health.
- `api/status.js` reports runtime, governance, and execution integration state.
- `src/status.js` defines the status payload contract.
- `test/` protects the API methods and fail-closed status contract.

The status API is observability only. It is not an ASFDK authorization decision and must never be used to authorize a tool, model, or execution request. Agent execution is explicitly disabled in this shell.

## Runtime foundation

The MVP consumes the checked-in `@earendil-works/pi-coding-agent` workspace at `packages/coding-agent`. The root npm workspace and lockfile make this source authoritative; the MVP does not independently install a potentially different registry release.

Run installation from the repository root. The MVP typecheck is included in the root `npm run check` command as `check:mvp`. Its focused tests run through the workspace test command:

```bash
npm run test --workspace=@neurolift/nlt-pi-mvp
npm run typecheck --workspace=@neurolift/nlt-pi-mvp
```

For the Vercel project using `mvp/` as its Root Directory, **Include source files outside the Root Directory** must remain enabled so the root workspace and `packages/coding-agent` remain available during installation and build.

## Ownership boundaries

- **MVP application:** user-facing application surface and request lifecycle.
- **`packages/coding-agent`:** agent runtime, SDK, sessions, and coding-agent capabilities.
- **ASFDK:** governance and authorization remain separate from model intent and tool availability.
- **AgentOS:** execution environment (the agent's "computer"), not an authority source.
- **Human:** final authority for consequential actions.

## Integration sequence

1. Establish the application surface and health/status observability.
2. Compose the checked-in Pi runtime behind a server-only adapter.
3. Integrate the ASFDK foundation, harness, and MCP layers at their respective boundaries.
4. Bind every model/tool invocation to an explicit governance decision.
5. Verify the independent AgentOS execution boundary and approval/escalation behavior.
6. Add authenticated sessions and persistence only after their providers and data contracts are explicitly selected.

Do not expose coding-agent tools to requests until the ASFDK harness and execution boundary are integrated and verified. Do not interpret the status endpoint as proof of authorization. Do not treat this scaffold as a production-ready agent.

## ASFDK harness source

The ASFDK harness client is vendored under `src/harness/` from `NeuroLift-Technologies/asfdk-harness` (no package is published). See `src/harness/README.md` for provenance, scope, and re-sync rules. The foundation it wraps, `@neurolift-technologies/asfdk`, is a published dependency.

The coding-agent workspace packages resolve through their built `dist`, so build before typechecking (CI runs `npm run build` before `npm run check`). In a fresh container after `npm ci --ignore-scripts`, the root `build` script failed in `pi-ai` until `pi-schema` and `pi-telemetry` had been built first (`npm run build --workspace=@earendil-works/pi-schema`, then `--workspace=@earendil-works/pi-telemetry`). The root `build` script does not list those two packages. This was not investigated further.

## Governed turn

`createNltCodingAgent()` exposes a deterministic governed turn surface (`governedTurn`) that runs a user prompt through the ASFDK harness before any coding-agent turn may execute:

- Crisis / emotional assessment (Sleepwalker Protocol + RRT Advocate handoff) via `harness.assessText`.
- The gate (`src/gate.ts`) returns `allowed: false` with a `blockedReason` — escalation to a human precedes agent execution — when the foundation reports a critical or emergency crisis level (`rrt.CrisisLevel.RED` / `BLACK`, whose runtime values are `"critical"` / `"emergency"`), when an explicit suicidal-ideation, self-harm, or inability-to-ensure-safety flag is set, or when the assessment failed or is unavailable (fail closed).
- The gate depends on the upstream RRT Advocate detector, which is a keyword-based prototype. It does not detect every crisis statement (for example, some phrasings of suicidal intent are not recognized), so it is not a substitute for human review.
- Non-blocking assessments return `allowed: true` with the interaction, emotional state, governance, and continuity context needed to feed the subsequent coding-agent turn.

`runNltCodingTurn()` wraps the above into a single governed turn entry point: assess → block-or-run → inject governed system prompt (ASFDK protocol + preflight) → execute through the pi-coding-agent runtime (ASFDK extension loaded) → return the final assistant response plus post-turn governance/continuity bookkeeping.

The MVP does not yet persist continuity or run a separate post-turn response-governance pass; those remain explicit follow-up agent-side work.

## Current deployment posture

The Vercel project is configured with `mvp/` as its root and the repository root included as a source directory. This change does not trigger a deployment, configure production environment variables, select an authentication provider, or provision persistence.
