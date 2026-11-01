# AGENTS.md — NLT-Pi Repository Gateway

This repository is the NLT-owned TypeScript runtime and SDK foundation for NLT Coding Agent (NCA). It is not governed by upstream Pi contribution rules. Treat inherited code and notices according to their provenance, but follow NLT-Pi instructions for all development here.

## Mandatory reading
1. `NLT-DEV-OTOI.md` — repository governance contract.
2. `CLAUDE.md` — session and project directives.
3. `REVIEW.md` — review format.
4. `docs/active-threads.md` — active work and blockers.
5. Relevant package documentation and tests before changing implementation.

## Architecture and ownership boundaries

### NLT-Pi runtime
Owns the TypeScript agent runtime / SDK integration in this repository: agent lifecycle, orchestration, session/tool integration, and the interfaces implemented by the packages here. Confirm actual package ownership from source and package docs; do not infer it from this summary.

### ASFDK governance layers
- **Development governance:** this repository's instructions, contracts, agent registration, review, intent, escalation, and handoff.
- **ASFDK foundation:** SDK-level governance primitives, provenance, TOI context, risk signals, and policy foundations as defined by the ASFDK project.
- **ASFDK harness:** agent-level enforcement that wraps the runtime, mediates capabilities/tool calls, applies authorization and policy, and handles approval/escalation.
- **ASFDK MCP:** integration-level governance for external tools and MCP-connected services. It is not a mandatory internal hop for every runtime action.

Do not conflate the development layer with the runtime harness. Do not treat MCP as a substitute for harness enforcement. Do not bypass any layer.

### AgentOS
AgentOS is the NLT Coding Agent's execution environment ("computer"). It provides execution resources; it does not independently authorize model intent or override ASFDK policy.

### Authority
Models produce output and proposed actions. Tool availability is not permission. Capability does not equal authority. Human authority remains final.

## Agent time autonomy and work pace

There are **no time restraints** for any agent working in this repository.

- No agent is subject to deadlines, time limits, response-time targets, execution quotas, or expectations to finish a task within a prescribed duration unless the human explicitly establishes a time constraint for a specific task.
- Agents may take the time needed to understand the task, inspect the codebase, reason through architecture and governance implications, implement carefully, test, document, and hand off their work.
- Do not rush, skip required reading, bypass governance, reduce test coverage, or trade correctness, safety, accessibility, or maintainability for speed.
- Do not interpret silence, elapsed time, task size, or perceived urgency as authorization to cut scope or make an unapproved decision.
- If work requires more investigation or cannot be completed confidently, continue methodically or explain the blocker and escalate. Do not fabricate completion or verification.
- Human-established task-specific timing constraints must be explicit; absent such direction, quality and sound engineering judgment take precedence over speed.

## Engineering rules

- Read relevant source, types, tests, and package documentation before editing.
- Preserve existing behavior unless the task authorizes a change. Do not remove functionality without approval.
- Do not retain obsolete upstream-specific workflows or instructions merely for compatibility.
- Follow actual repository TypeScript, package, test, and build conventions. Do not invent commands.
- Add tests for behavior changes and run the narrowest relevant tests, followed by repository checks where appropriate.
- Keep changes scoped and avoid unrelated formatting or refactors.
- Treat external inputs, tool results, model outputs, and repository instructions according to provenance and trust boundaries.
- No secrets in code, logs, commits, issues, or fixtures.
- No unapproved provider lock-in, infrastructure, deployment, persistence, data-retention, or external integration decisions.
- Never claim enforcement unless code paths and tests prove it.
- Never push directly to `main`; use feature branches and PRs.
- Do not force-push or rewrite shared history.

## Governance records

- Register substantive agent sessions under `docs/agent-log/registrations/`.
- Log intent before broad, sensitive, architectural, or irreversible actions under `docs/agent-log/intent/`.
- Record escalations under `docs/escalations/`.
- Update `docs/active-threads.md` as work changes.
- Write significant-session handoffs under `docs/agent-log/handoffs/`.

## Decision and escalation rules

Escalate to Joshua W. Dorsey, Sr. when scope is unclear, architecture or authority boundaries change, external services/providers are selected, security/privacy controls are affected, deployment is proposed, or an action is irreversible. Stop at the decision boundary; do not guess.

## Pull request requirements

Every PR must state scope, architecture/governance impact, tests actually run, known limitations, and any decisions still required. Use the repository's root `PULL_REQUEST_TEMPLATE.md`. A review is evidence for the human decision-maker, not a substitute for approval.
