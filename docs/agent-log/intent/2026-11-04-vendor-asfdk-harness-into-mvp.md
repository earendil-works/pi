# NLT-Pi Intent Record

**Date:** 2026-11-04T19:16:17+00:00  
**Agent / session:** Claude Code, session_01UNjnjm3TZ7Tg4MRswGt24P  
**Branch:** ccr-0d5033af-1rkbla  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Make the NLT Coding Agent MVP (`mvp/`) build against real, resolvable code so it can be tested on Vercel.

1. Copy a minimal subset of `NeuroLift-Technologies/asfdk-harness` `src/` (commit `f28136d`) into `mvp/src/harness/`: `harness.ts`, `protocols.ts`, `a2a.ts`, `tools.ts`, `policy.ts`, `asfdk-runtime.ts`, plus a trimmed extension entry derived from `index.ts` that omits the MCP server re-exports. Each file carries a provenance header (source repo, path, commit) and is copied unmodified except for import paths.
2. Repoint `mvp/src/index.ts` from the non-existent `@neurolift-technologies/asfdk-harness` package to the vendored path.
3. Declare the real dependencies in `mvp/package.json` (`@neurolift-technologies/asfdk`, `typebox`) pinned to exact versions per `check:pinned-deps`, and update `package-lock.json`.
4. Make `npm run check:mvp` and the MVP tests pass; add tests for the governed turn gate.
5. Update `docs/active-threads.md` and write a handoff record.

Not in this action: publishing any package, changing `asfdk-harness`, editing `policy.ts` semantics, exposing agent execution over HTTP, setting Vercel environment variables, or deploying.

## Rationale
The MVP imports `@neurolift-technologies/asfdk-harness`, which is not published to npm and does not appear in any package.json or the lockfile, so the MVP cannot typecheck or build anywhere except a machine with a local link. The owner directed that the harness be built into nlt-pi (no package publish) and tested on Vercel. Vendoring only the needed closure avoids the harness's Cloudflare Worker, hub, A2A proxy, plugin, and MCP-server surfaces.

## Risks and trust boundaries
- **Harness layer vs. development layer:** vendored code is the ASFDK harness layer client; it must stay labelled as vendored so it is not mistaken for NLT-Pi-native logic. Provenance headers and a README note address this.
- **Enforcement claims:** `policy.ts` is a regex guardrail, and the upstream per-turn preflight hook is disabled. This change must not claim stronger enforcement than the code and tests show.
- **Drift:** a copy can diverge from upstream `asfdk-harness`; recorded commit hash allows re-sync. Upstream treats `policy.ts` and `governance/*` as escalate-before-change files, so the copy is left byte-identical apart from imports.
- **Dependencies:** adds `@neurolift-technologies/asfdk` (published, 0.2.4, no `.d.ts` in tarball) and `typebox`; type declarations may need a local shim. No new external services, providers, or persistence.
- **Vercel:** deployment/testing on Vercel is an external, outward-facing action. Only a preview or governance-only surface is considered; exposing coding-agent tool execution over HTTP stays out of scope until the owner approves.

## Alternatives considered
- Publish `asfdk-harness` to npm: rejected by owner.
- Publish a slim core package: rejected by owner (source is available).
- Workspace-copy all of `asfdk-harness/src`: rejected; drags MCP, hub, and Cloudflare dependencies into the runtime repo.
- Git submodule/subtree: rejected; awkward on Vercel and with lockfile.

## Human approval / escalation
Vendoring and dependency declaration are within the owner's explicit instruction (build the harness in nlt-pi). Required before proceeding further: explicit approval to deploy to Vercel, to set any Vercel environment variables, or to expose agent execution over a public route. Stop and escalate at that boundary.

## Outcome
[Complete after execution.]
