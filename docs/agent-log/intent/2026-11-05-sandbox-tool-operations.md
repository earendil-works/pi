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
