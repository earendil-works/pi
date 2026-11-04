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
- Local verification: MVP typecheck, MVP tests (7 node + 26 vitest), pinned-deps, runtime-deps, ts-imports, entry-graphs, install-lock, biome, and the governance validator all passed. Full root `npm run check` and root tests were not run.
- Vercel: the push produced a preview deployment (`dpl_FpQAQSotFRZkqrFwgE5PeHUBakHv`) that reached READY. The build log contained `error TS2688: Cannot find type definition file for 'node'` from the function transpile step; fixed in `b018928` (node types moved to a typecheck-only tsconfig), and the build of that commit logs no TS error. The endpoint itself has NOT been invoked on Vercel: the available Vercel connection could not fetch the protected preview. No environment variables, production deployment, or project settings were changed.

## Addendum: removal of inherited CI workflow (2026-11-04)
At the owner's direction ("the ci checks were from the pi fork they can be deleted"), `.github/workflows/ci.yml` (jobs `build-check`, `test`, `mcp-conformance`) was deleted from this branch. It was inherited from the upstream Pi fork and had failed on `main` for its last five runs because the root build never builds `pi-schema`/`pi-telemetry` before `pi-ai`. Consequences: no automated build/test check remains on PRs other than `validate-nlt-governance.yml` and CodeQL; `preview-packages.yml` (triggered by `workflow_run` on "CI", publishes to pkg.earendil.com) can no longer fire. `preview-packages.yml` and the other inherited workflows were NOT changed and are flagged for the owner. `packages/coding-agent/test/mcp-conformance/README.md` still says CI runs conformance from `ci.yml`; not changed.

## Addendum: removal of preview-packages (2026-11-04)
At the owner's direction ("remove the preview packages"), `.github/workflows/preview-packages.yml`, `scripts/preview-packages.mjs`, and `scripts/preview-packages.test.mjs` were deleted. The workflow was inherited from the Pi fork, depended on the removed `ci.yml` via `workflow_run`, and also ran on `pull_request_target: closed` to delete a PR ref at `pkg.earendil.com` (the upstream Pi package registry, not an NLT registry). The script and test were referenced only by those two workflows. Other inherited workflows (`build-binaries`, `nix`, `npm-audit`, `issue-analysis`, `issue-triage-labels`, `publish-model-catalog`, `remove-inprogress-on-close`) were not changed.

## Addendum: removal of remaining inherited Pi workflows (2026-11-04)
At the owner's direction ("Yes remove them"), the remaining inherited Pi-fork workflows were deleted: `build-binaries.yml`, `issue-analysis.yml`, `issue-triage-labels.yml`, `nix.yml`, `npm-audit.yml`, `publish-model-catalog.yml`, `remove-inprogress-on-close.yml`. Only `validate-nlt-governance.yml` (NLT-owned) remains in `.github/workflows/`. Scripts, `.pi/` skills/extensions, and docs that mention these workflows by name were not changed and may now be stale: `.pi/skills/release.md` (mentions `build-binaries` and `nix`), `scripts/build-binaries.sh`, `.pi/extensions/import-repro.ts` (mentions `issue-analysis`), and `packages/coding-agent/test/mcp-conformance/README.md` (mentions the removed `ci.yml`). Repository-level effects: no automated release/binary build, Nix build, npm audit, model-catalog publish, or issue triage/analysis automation remains; GitHub CodeQL is configured outside these files.

## Addendum: documentation and script clean-up (2026-11-04)
At the owner's direction ("Cleanup the docs and scripts"), stale mentions of the removed workflows were updated: `.pi/skills/release.md` (NLT-Pi notice added at the top; upstream steps 4-6 replaced by a single "removed" step; it states NLT-Pi has no approved release process and that publishing needs the owner's approval), `scripts/build-binaries.sh` (header comment), `.pi/extensions/import-repro.ts` (header comment and command description), and `packages/coding-agent/test/mcp-conformance/README.md` (no longer runs in CI). No behavior changed: comments, descriptions, and docs only. Not changed: `nix/`, `flake.nix`, `scripts/release*`, and other inherited Pi release tooling, which are separate decisions.

## Addendum: review findings (CodeRabbit, 2026-11-04)
CodeRabbit reviewed commit 47b727e (9 findings, 1 nitpick). Each was checked against the code.

Fixed (own code):
- `gate.ts`: a missing (null/undefined) emotional state now fails closed. Verified: in `crisis_only` and `framework` modes the foundation returns no emotional state and involves no components, and the crisis prompt "I want to kill myself" was allowed. `GateDecision` gained `assessmentFailed`.
- `api/govern.ts`: returns 503 (not 200) whenever the assessment did not run or was incomplete; runs from the OS temp directory (`process.chdir`) because the foundation's Sleepwalker storage path is a fixed relative `.swp_storage` under `process.cwd()`, which is read-only on Vercel (the harness's own `cwd` option and `/tmp` fallback do not affect it); uses a per-request random user id so continuity state is not shared between callers. A mutation check (removing the chdir) fails the new test.
- Tests no longer need a built `dist`: `createNltCodingAgent` moved to `src/governed-agent.ts` (no coding-agent runtime import); `@earendil-works/pi-coding-agent` exports only `dist`, so importing `src/index.ts` failed on a fresh checkout. Typecheck still needs the workspace build.
- Added the EACCES optional-file test (nitpick).

Not changed here (vendored upstream files; changes belong in asfdk-harness and need the owner's approval, then re-sync): `policy.ts` destructive-command patterns do not match `rm -fr`, `rm -rf -- /path`, or shell globs for sensitive paths (a known limit of the regex guardrail, consistent with the README's "guardrail, not a security boundary"); `tools.ts` `asfdk_protocol_status` returns unredacted protocol paths (the Pi tool is not used by `/api/govern`); `protocols.ts` serves the same inline TOI content for every `.toi` source URI and does not use the `honor` result (inline content is unused by the MVP); `harness.ts` `/tmp` fallback (addressed for the endpoint in `govern.ts`).

Corrected statement: earlier text said the endpoint "persists nothing". The foundation may write ephemeral continuity files under the temp directory of the function instance; no durable storage is used.
