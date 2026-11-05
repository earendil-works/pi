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
The owner answered "Egress allow, approvals yes, login added again". Changes made: the sandbox lifecycle default moved from deny-all to a named allowlist (package registries and GitHub, `DEFAULT_AGENT_EGRESS`), still with no allow-all option and deny-all available. Risks recorded: the sandbox holds no credentials, so allowed domains give read access to public content, not a way to publish or push; a model-directed shell can still fetch arbitrary content from those hosts (prompt-injection exposure), contained to the sandbox. "Login added again" was verified rather than assumed: Standard Protection is on, but the primary production domain `nlt-pi-mvp.vercel.app` still answers 200 to anyone, so the agent route must refuse on production deployments. I read "egress allow" as an allowlist, not allow-all, and "approvals yes" as agreement with the proposal (no prompts inside the sandbox); both are recorded in NLTPI-MVP-005 so the owner can correct them.

## Addendum: login now covers all deployments (2026-11-05)
The owner switched Vercel Authentication to all deployments. Verified rather than assumed: `ssoProtection.deploymentType` is `all`, and every domain, including production, returns a login redirect for pages and 401 for API calls. This closes the production-domain gap recorded in the previous addendum, so the plan to hard-refuse the agent route on production is dropped; the route will instead be off unless an owner-set flag enables it per environment. Remaining risk: the protection is a project setting the owner can change, so the flag stays as the second control.
