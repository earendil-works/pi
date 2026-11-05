# NLT Coding Agent MVP

This directory is the application boundary for the first NLT Coding Agent MVP and the configured Vercel project root.

## Vercel application shell

The initial Vercel surface is a read-only status application:

- `public/status.html` provides the accessible, responsive status UI (it was the front page before the chat page; see Chat page below).
- `public/index.html` is the chat page served at `/`.
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

The coding-agent workspace packages resolve through their built `dist`, so build before typechecking (the vitest tests import `src/governed-agent.ts` and `api/govern.ts`, which do not load the coding-agent runtime, so they run without a build). In a fresh container after `npm ci --ignore-scripts`, the root `build` script failed in `pi-ai` until `pi-schema` and `pi-telemetry` had been built first (`npm run build --workspace=@earendil-works/pi-schema`, then `--workspace=@earendil-works/pi-telemetry`). The root `build` script does not list those two packages. This was not investigated further. The inherited Pi-fork `ci.yml` workflow, which failed on this for the same reason, was removed; run the checks locally (`npm run check:mvp`, `npm run test --workspace=@neurolift/nlt-pi-mvp`).

## Behavior corpus

`test/corpus/` holds prompts and shell commands with the expected gate / policy outcome (`test/corpus.test.ts`). `must*` entries are asserted. `known*` entries are things the upstream component (the RRT keyword detector, the harness `policy.ts`) should handle but does not yet; they are `it.fails` tests, so they turn red when an upstream fix is re-synced and must then be moved to the asserted list. The crisis detector currently allows several unambiguous statements (for example "I want to die"), and `policy.ts` does not match forms such as `rm -fr ~` or `cat .en?`. Do not describe the gate or the guardrail as complete.

## Sandbox tool operations

`src/sandbox/operations.ts` builds the swappable `bash`, `read`, `write` and `edit` operations that the Pi coding-agent tools accept, so they act inside a Vercel Sandbox instead of on the machine running the agent loop. The owner chose Vercel Sandbox as the first execution environment (2026-11-05).

It is library code only. It does not create a sandbox, read credentials, open a connection, or expose a route, and nothing in the application calls it yet. The route that will use it must refuse to run on production deployments (see `NLTPI-MVP-005`).

What it enforces, with tests that use a fake sandbox:
- every call is reviewed by the harness policy (`reviewToolCall`) first; anything other than `allow: true` is refused;
- file paths and the command directory must stay inside one workspace root, including after symlink resolution, and including creating a file under a symlinked directory that leads outside;
- the caller's environment is never forwarded to the sandbox (it comes from the host process and can hold credentials); only a fixed, configured environment is;
- commands always have a timeout (default 2 minutes, at most 10), and output (1 MiB), file reads (10 MiB) and writes (2 MiB) are capped;
- any sandbox error is an error, never a pass.

The path checks are a guardrail for the file tools, not the security boundary. The sandbox is: it is isolated, and new sandboxes get a limited outbound policy (see Sandbox lifecycle); `DEFAULT_SANDBOX_NETWORK_POLICY` remains `deny-all` for callers that build their own. `bash` inside the sandbox can do anything the sandbox allows, which is why egress and secrets must be handled at the sandbox level.

`@vercel/sandbox` is pinned to 3.6.1. Newer releases (3.7.0 and later) pull in a transitive `zod@4.1.11` through `@vercel/cli-config` that `npm audit` flags as high severity (memory exhaustion on oversized collections), so they are not used until that is fixed upstream.

## Sandbox lifecycle

`src/sandbox/lifecycle.ts` decides how the agent's one sandbox is found, created and shared. The owner's Vercel plan allows one sandbox (and the Hobby plan caps a session at 45 minutes), so the agent uses exactly one fixed-name, persistent sandbox (`nlt-agent`), found or created on demand with `Sandbox.getOrCreate`, never one per conversation.

- **Settings are a small envelope:** one vCPU by default (1 or 2 allowed), a session length from 1 to 40 minutes (default 30), and only the last snapshot kept. Outbound traffic is limited to named domains: by default package registries (npm, yarn, PyPI) and GitHub (clone and raw content), as the owner allowed on 2026-11-05. Pass an empty preset list to deny everything. There is no way to allow all traffic; extra domains must be exact hosts (a bare `*`, a scheme, a port or a path is refused). No credentials are placed in the sandbox, so these domains give read access to public content, not a way to publish or push. Hobby does not support transform or forwarding rules, which are not used.
- **One turn at a time:** `withAgentSandbox` takes a lock inside the sandbox (an atomic `mkdir`) and releases it afterwards. A second turn gets `SandboxBusyError` and does not touch the first turn's lock. A lock older than 15 minutes is treated as abandoned and taken over. Anything unexpected while locking is a failure, not permission to run.
- The lock commands are fixed text; no model or user input reaches them. An agent with `bash` inside the sandbox could delete the lock, which would only allow two turns to overlap in the owner's own sandbox.
- `src/sandbox/vercel-client.ts` is the real client. It is kept separate so the lifecycle logic and its tests never load the SDK, and it is compile-checked against the real SDK types. Calling it creates or resumes a real, billed sandbox, so nothing calls it yet.

## Free-model selection

`src/gateway/free-models.ts` implements the owner's rule that only free models go through the Vercel AI Gateway. It reads the gateway's public model catalog (`https://ai-gateway.vercel.sh/v1/models`, no authentication) at the time of use and treats a model as free only if it is a language model whose input and output prices are listed and exactly zero, every other price field is also zero, and its price is not flagged `varies_by_provider`. Missing, tiered, regional, unrecognised or malformed pricing is not free.

`pickFreeModel()` returns the best free model with tool support (preferred ids first, then larger context, then id order). A specific model can be requested, but it is used only if it is free right now; it is never swapped for another. If the catalog cannot be read, nothing is free, or the requested model is not free, it throws `NoFreeModelError`, and the caller must refuse the turn instead of using a priced model. No model identifiers are written in source.

On 2026-11-05 the live catalog listed 320 language models; 3 were selectable. A fourth was listed at zero but flagged `varies_by_provider`, so it is excluded.

Like the sandbox operations, this is unwired library code: it makes no model call and holds no credentials.

## Governed turn

`createNltCodingAgent()` exposes a deterministic governed turn surface (`governedTurn`) that runs a user prompt through the ASFDK harness before any coding-agent turn may execute:

- Crisis / emotional assessment (Sleepwalker Protocol + RRT Advocate handoff) via `harness.assessText`.
- The gate (`src/gate.ts`) returns `allowed: false` with a `blockedReason` — escalation to a human precedes agent execution — when the foundation reports a critical or emergency crisis level (`rrt.CrisisLevel.RED` / `BLACK`, whose runtime values are `"critical"` / `"emergency"`), when an explicit suicidal-ideation, self-harm, or inability-to-ensure-safety flag is set, or when the assessment failed, is unavailable, or produced no emotional state (fail closed). The foundation returns no emotional state in modes that disable Sleepwalker (for example `crisis_only` and `framework`), so those modes cannot clear the gate; `ASFDK_MODE` must be `unified` (the default) for turns to be allowed.
- The prompt is assessed on the default `UNKNOWN` channel (owner decision, 2026-11-04). Untrusted text can raise protections but never lower them, so gate outcomes were identical on `USER_INPUT` in testing. Revisit when authenticated sessions exist, and set `USER_INPUT` only for text that arrived from the signed-in user.
- The gate depends on the upstream RRT Advocate detector, which is a keyword-based prototype. It does not detect every crisis statement (for example, some phrasings of suicidal intent are not recognized), so it is not a substitute for human review.
- Non-blocking assessments return `allowed: true` with the interaction, emotional state, governance, and continuity context needed to feed the subsequent coding-agent turn.

`runNltCodingTurn()` wraps the above into a single governed turn entry point: assess → block-or-run → inject governed system prompt (ASFDK protocol + preflight) → execute through the pi-coding-agent runtime (ASFDK extension loaded) → return the final assistant response plus post-turn governance/continuity bookkeeping.

The MVP does not yet persist continuity or run a separate post-turn response-governance pass; those remain explicit follow-up agent-side work.

## Chat page

`public/index.html` (with `app.css`, `app.js`, `lib/decision.js`) is a chat page for the Vercel preview. It uses no framework and no build step. Each message is sent to `POST /api/govern` and the page shows the gate's verdict. It does not call a model, run a tool, sign anyone in, or save anything: conversations live in memory for the open tab only, and user text is only written with `textContent`.

Values on the page come from `GET /api/health`, `GET /api/status` and the gate response (verification state, crisis level, components that checked, execution state). Where nothing is connected it says so ("None connected", "Disabled"); it does not show a governance "green" state. Anything other than a literal `allowed: true` from the gate (a 503, a 404 on production, a malformed body, a network error) is shown as not allowed. The previous status page is at `/status.html`.

The blocked-message wording in `lib/decision.js` is placeholder copy and needs owner (and clinician) review. A framework such as Next.js is a separate decision for the owner.

## Current deployment posture

The Vercel project is configured with `mvp/` as its root and the repository root included as a source directory. This change does not trigger a deployment, configure production environment variables, select an authentication provider, or provision persistence.
