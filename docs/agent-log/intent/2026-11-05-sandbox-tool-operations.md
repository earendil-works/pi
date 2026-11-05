# NLT-Pi Intent Record

**Date:** 2026-11-05T02:23:05+00:00
**Agent / session:** Claude Code, session_01UNjnjm3TZ7Tg4MRswGt24P
**Branch:** ccr-0d5033af-1rkbla (restarted from `main` after PR #18 merged)
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
The owner asked to wire in the coding agent ("This is a coding agent for myself"), chose full coding tools in a sandbox, and then chose **Vercel Sandbox** as the execution environment. This is step 1 of that work.

1. Add `mvp/src/sandbox/operations.ts`: bash/read/write/edit operations for the Pi coding-agent tools, backed by a Vercel Sandbox handle passed in by the caller.
2. Add `@vercel/sandbox` 3.6.1 (exact pin) to `mvp/package.json` and the lockfile.
3. Tests with a fake sandbox, plus a type-level check that the real `Sandbox` satisfies the interface.
4. README, active-threads (NLTPI-MVP-005), handoff.

Not in this action: creating a sandbox, reading credentials, any route or UI change, a model call, setting Vercel environment variables or project settings, changing Vercel Authentication, or any deploy beyond what merging already does. The module is not called by anything.

## Rationale
The owner decided the execution environment. A route that runs model-directed commands cannot be exposed until access control is decided (the owner's answer was ambiguous), so the part that does not depend on that decision is built first and left unwired.

## Risks and trust boundaries
- **Execution authority:** the sandbox is an execution environment, not an authority. Every call goes through the harness policy first, and refusals are not bypassable from inside the operations.
- **Secret leakage:** the shell tool receives the host process environment (which can hold the gateway credential). The operations never forward it; a test and a mutation check cover this.
- **Escape from the workspace:** paths are confined lexically and after symlink resolution. This is a guardrail; the isolated sandbox is the boundary, and `bash` inside it is unrestricted by these checks.
- **Egress:** new sandboxes should be created with `deny-all`; `DEFAULT_SANDBOX_NETWORK_POLICY` records that. An allowlist is an explicit later choice.
- **Dependency:** `@vercel/sandbox` is a new external dependency, approved by the owner's choice. 3.9.0 and 3.7.0+ pull a transitive `zod@4.1.11` flagged high by `npm audit`; 3.6.1 audits clean (repo-wide `npm audit`: 0 vulnerabilities). It was also released about a month before use.
- **Cost:** sandboxes are billed; nothing creates one here.

## Alternatives considered
- Vercel Sandbox with a custom `SandboxLike` interface (chosen) vs. importing the SDK type everywhere: the narrow interface keeps tests free of the SDK and is checked against the real type.
- AgentOS proper, or running locally: offered to the owner; not chosen.
- `@vercel/sandbox` 3.9.0 with an npm override for zod: rejected; overriding a transitive pin goes beyond what its maintainers tested.

## Human approval / escalation
Execution environment: chosen by the owner. Still needs the owner before any route or sandbox creation: access control, approval defaults, egress policy, and cost/plan (see NLTPI-MVP-005).

## Outcome
See the handoff record `2026-11-05-sandbox-tool-operations.json` and the PR.

## Addendum: free-model selection and owner direction (2026-11-05)
The owner said "I'll add the vercel login once everything is running", so the rest of the agent is being built now with the route off by default (a flag the owner sets in Vercel). Stacked on this PR, because both are unwired agent building blocks and the designated branch was occupied: `mvp/src/gateway/free-models.ts`, which implements the owner's free-models-only rule by reading the live public gateway catalog at use time and failing closed. No new dependency, no credentials, no model call, no route. The remaining plan (agent runner, then the route and chat-page streaming) is in `docs/active-threads.md` NLTPI-MVP-005 and will be separate PRs. Risk noted: if the owner turns the route on before Vercel login is on, anyone with the URL could start billed sandboxes; the flag makes that an explicit decision.

## Addendum: one-sandbox plan limit (2026-11-05)
The owner said the free account allows one sandbox. Added `mvp/src/sandbox/lifecycle.ts` (one fixed-name persistent sandbox found or created with `getOrCreate`, a safe settings envelope, a one-turn-at-a-time lock) and `mvp/src/sandbox/vercel-client.ts` (the real client, compile-checked against the SDK, never called). No credentials, no sandbox is created, nothing is wired. Risk noted: the Vercel docs I found state a Hobby limit of 10 concurrent sandboxes and a 45-minute session cap, which differs from the owner's "1 sandbox"; the design satisfies both and the real limit is unverified until a sandbox is created. The lock lives inside the sandbox, so an agent with shell access could remove it; the effect is limited to overlapping turns in the owner's own sandbox.

## Addendum: owner answers on egress, approvals and login (2026-11-05)
The owner answered "Egress allow, approvals yes, login added again". Changes made: the sandbox lifecycle default moved from deny-all to a named allowlist (package registries and GitHub, `DEFAULT_AGENT_EGRESS`), with deny-all available (an allow-all option was added later, see the addendum below). Risks recorded: the sandbox holds no credentials, so allowed domains give read access to public content, not a way to publish or push; a model-directed shell can still fetch arbitrary content from those hosts (prompt-injection exposure), contained to the sandbox. "Login added again" was verified rather than assumed: Standard Protection is on, but the primary production domain `nlt-pi-mvp.vercel.app` still answers 200 to anyone, so the agent route must refuse on production deployments. I read "egress allow" as an allowlist, not allow-all, and "approvals yes" as agreement with the proposal (no prompts inside the sandbox); both are recorded in NLTPI-MVP-005 so the owner can correct them.

## Addendum: login now covers all deployments (2026-11-05)
The owner switched Vercel Authentication to all deployments. Verified rather than assumed: `ssoProtection.deploymentType` is `all`, and every domain, including production, returns a login redirect for pages and 401 for API calls. This closes the production-domain gap recorded in the previous addendum, so the plan to hard-refuse the agent route on production is dropped; the route will instead be off unless an owner-set flag enables it per environment. Remaining risk: the protection is a project setting the owner can change, so the flag stays as the second control.

## Addendum: allow-all egress option (2026-11-05)
The owner said "let allow all as an option" and clarified that "approvals yes" means agent turns run in the sandbox without extra prompts. Change made (nlt-pi#21): `egressAll: true` in `agentSandboxParams`/`withAgentSandbox`, explicit and boolean-only, never the default; the default stays the named allowlist. Risk recorded: the sandbox holds no credentials, so allow-all exposes nothing to read, but it lets anything the agent can see (the workspace, fetched content) be sent to any host, and widens prompt-injection exposure. Who may set it: only the agent route, from an owner-set per-environment flag (the same flag family that keeps the route off by default); no model or tool path can set it. Not yet verified: whether `updateNetworkPolicy` takes effect for the current session or only the next one, and the real allow-all behaviour of the egress proxy, since no sandbox has been created.

## Addendum: agent runner (2026-11-05)
The owner asked for the runner on the same branch and PR (nlt-pi#21), so that PR now carries two changes: the allow-all option and `mvp/src/agent/runner.ts`. The runner composes existing, reviewed pieces and adds no new external call, dependency, route, credential, or persistence: gate first, free model from the live catalog, the sandbox lock, Pi tools bound to the policy-reviewed sandbox operations, built-in host tools disabled, no host resources loaded. The credential is read inside the turn and kept in memory. Risks recorded: prompt-injection exposure through a model-directed shell is contained to the sandbox but widened by allow-all; the real gateway call, tool names sent to the model, and the sandbox working directory (`/vercel/sandbox`) are unverified until a first real run. Nothing calls the runner.

## Addendum: agent route (2026-11-05)
The owner said "Start it" for the route PR. Added `mvp/api/agent.ts`, `mvp/src/agent/route.ts`, `mvp/vercel.json`, chat-page streaming, and the exact-pinned `@vercel/oidc` 3.2.0 (already in the lockfile as a transitive dependency of the sandbox SDK; now a direct dependency because the route imports it). Controls: the route is off unless the owner sets `NLT_AGENT_ENABLED=1` per environment; `egressAll` only from the owner-set `NLT_AGENT_EGRESS_ALL=1`, never the request body; effective policy logged without the prompt; the crisis gate runs first inside the runner; the credential is read inside the request. Risks recorded: once enabled, the route runs a model-directed shell in the owner's sandbox (contained to the sandbox, widened by allow-all); a long turn costs sandbox time and the function can reach 300 seconds; the page's 2000-character client limit is lower than the route's 8000. Not verified: any live call (gateway, sandbox, OIDC token on a deployment, streaming through Vercel).

## Addendum: review fixes on the agent route (2026-11-05)
Owner review (nlt-pi#26) found two High issues. (1) The function limit (300 s) was shorter than the lifecycle turn deadline (12 min plus grace). The route now passes a 320 s stale age, so the abort is at 256 s and the turn settles by 288 s; a test reads `vercel.json` and checks the window. `maxDuration` was not raised. (2) The gate called `process.chdir()` on every request. It now chooses one temp directory per process and never changes it again (`gate-workdir.ts`), with a test that 20 overlapping calls leave the directory unchanged. Residual risk, not removed: that single chdir is still process-wide, because the foundation does not let the Sleepwalker storage path be configured; the full fix is running the gate in a child process, which I did not do because bundling a worker file on Vercel is unverified. Owner decision.

## Addendum: invocation deadline (2026-11-05)
Second owner review (nlt-pi#26, de0e689): the lifecycle started a fresh 256 s timer after gate, catalog, sandbox acquire, lock and policy update, so total request time could exceed 300 s. Fix: the route sets an absolute deadline at entry (270 s); `withinDeadline` bounds each setup stage in the runner and lifecycle; the turn aborts at min(80% of stale age, deadline minus grace); a turn that has no time left never starts and releases its lock. Not verified live. The reviewer's Medium note is accepted: the once-per-process chdir is a documented constraint, not removed.

## Addendum: Vercel build failure from the deployment build command (2026-11-05)
Other agents pushed review fixes to this branch (e1d2a1f to 6ae8735). The last, 6ae8735, set the Vercel `buildCommand` to the root `build:offline`, and the preview deployment failed: the Vercel build log shows `check:model-data` failing because `packages/ai/src/providers/data/*.json` (generated, not committed) were missing. Fix: the build runs `hydrate:model-data` before `build:offline`, and a build-time assertion checks the Pi package entry (the earlier `require.resolve` check could not work, because the package only exports ESM). Risk recorded: the deployment build now depends on outbound network to public model lists and its generated model data can vary between builds; a pinned or committed snapshot would remove this and is an owner decision. Verified locally (hydrate, build:offline, assertion pass); the real check is the Vercel build for the pushed commit.

## Addendum: owner sign-in (2026-11-05)
The chat page's "Not signed in" label was a static placeholder. The owner asked for a real owner sign-in. Added Sign in with Vercel (OAuth code flow with PKCE) under `mvp/api/auth/` and `mvp/src/auth/`, an HMAC-signed 8-hour session cookie, an owner-set allow-list (`NLT_OWNER_VERCEL_SUBS`, ids or usernames), and a 401 on `/api/agent` without a session. This is a new authentication boundary, added on this branch (PR #26) because it gates that route; it can be split out if the owner prefers. Controls: fail closed when any setting is missing or the allow-list is empty; secret of at least 32 characters; state and PKCE verifier in a signed 10-minute cookie; allow-list re-checked on every request; no token or secret returned to the browser. Risks recorded: the Vercel app and its secrets are created and set by the owner; usernames can change or be reassigned, so ids are preferred; only the offline tests ran, not the live OAuth endpoints; the allow-list and secret live in environment variables. The Vercel Authentication wall is unchanged.

## Addendum: gateway data handling, free models only (2026-11-05)
I checked the live catalog: every strictly free model is marked `zdr: "none"` and `no_training: "none"`. The owner first chose "privacy wins", then, after seeing that this blocks every free model and what data a turn sends, chose free models only. No privacy filter or request option is applied; the chat page now shows a data notice (message, instructions, files and command output read in the turn go to the provider, which may keep them and train on them; gate-blocked messages are not sent). The privacy-first code was set aside in a local git stash, not pushed. Risk recorded: crisis content that passes the gate, and anything the agent reads in the sandbox, may be retained by a third-party provider; the notice is the only control.

## Addendum: notice wording, after the owner's PR #29 review (2026-11-05)
The notice box renders whether or not a turn can run (it is static HTML), so it now starts from the condition: "When an agent turn is allowed and runs, your message and any files or command output the agent reads are sent to the model provider, which may retain them or use them for training. Messages blocked by the governance check are not sent." The free-models-only restriction stays explicit. Read back in a headless browser at 1440 and 390 px. The same round reconciled NLTPI-MVP-003 (status, summary, the remaining retention item and the "rather than a user-facing notice" wording) with the merged route in #26/#27.
