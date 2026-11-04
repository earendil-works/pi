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

6. Add a preview-only `POST /api/govern` function (`mvp/api/govern.ts`) that returns the gate decision for a prompt. It does not start the coding agent, call a model, run a tool, or persist data, and returns 404 when `VERCEL_ENV` is `production`. This is the surface used to test the harness on Vercel.

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
Completed 2026-11-04 on branch `ccr-0d5033af-1rkbla` (draft PR #15).

- Vendored `harness.ts`, `protocols.ts`, `a2a.ts`, `tools.ts`, `policy.ts`, `asfdk-runtime.ts`, and a trimmed `extension.ts` from asfdk-harness `f28136d`. `policy.ts` is unchanged apart from a provenance header. All files differ from upstream in `.ts` relative import specifiers; `protocols.ts` additionally differs in `readOptionalFile` (single read instead of `access()` + `readFile()`), made to resolve CodeQL alert `js/file-system-race` (code-scanning alert 626) on this PR.
- Declared `@neurolift-technologies/asfdk` 0.2.4 and `typebox` 1.3.27, pinned the workspace coding-agent dependency to 1.4.0, added `vitest` 4.1.12 as a dev dependency.
- Deviation from the plan: testing the real foundation showed the MVP's crisis gate could never block (it compared the foundation's runtime level values to enum member names and read risk flags at the wrong nesting depth). The gate was moved to `mvp/src/gate.ts` and fixed; it also now fails closed when the emotional assessment is unavailable. This is MVP code, not upstream `governance/crisis.ts`, so no upstream escalate-only file was changed.
- An initial hypothesis that the default `UNKNOWN` channel prevented assessment was disproved by measurement and the default was left unchanged.
- Not fixed, flagged for the owner: the upstream RRT detector is a keyword prototype and missed some phrasings.
- Local verification: MVP typecheck, MVP tests (7 node + 19 vitest), pinned-deps, runtime-deps, ts-imports, entry-graphs, install-lock, biome, and the governance validator all passed. Full root `npm run check` and root tests were not run.
- Vercel: the push produced a preview deployment (`dpl_FpQAQSotFRZkqrFwgE5PeHUBakHv`) that reached READY. The build log contains `error TS2688: Cannot find type definition file for 'node'` from the function transpile step. The endpoint itself has NOT been invoked on Vercel: the available Vercel connection could not fetch the protected preview. No environment variables, production deployment, or project settings were changed.

## Addendum: removal of inherited CI workflow (2026-11-04)
At the owner's direction ("the ci checks were from the pi fork they can be deleted"), `.github/workflows/ci.yml` (jobs `build-check`, `test`, `mcp-conformance`) was deleted from this branch. It was inherited from the upstream Pi fork and had failed on `main` for its last five runs because the root build never builds `pi-schema`/`pi-telemetry` before `pi-ai`. Consequences: no automated build/test check remains on PRs other than `validate-nlt-governance.yml` and CodeQL; `preview-packages.yml` (triggered by `workflow_run` on "CI", publishes to pkg.earendil.com) can no longer fire. `preview-packages.yml` and the other inherited workflows were NOT changed and are flagged for the owner. `packages/coding-agent/test/mcp-conformance/README.md` still says CI runs conformance from `ci.yml`; not changed.
