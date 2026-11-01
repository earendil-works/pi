# SOP-NLT-001 — NLT-Pi Agent Onboarding

**Version:** 1.0.0  
**Scope:** Human and AI contributors working in NeuroLift-Technologies/nlt-pi  
**Authority:** Joshua W. Dorsey, Sr.

## Purpose
Ensure contributors understand the repository's authority model, architecture boundaries, active work, and required session records before substantive work begins.

## Procedure
1. Read `NLT-DEV-OTOI.md`, `AGENTS.md`, `CLAUDE.md`, and `REVIEW.md`.
2. Read `docs/active-threads.md` and check the current branch, working tree, and relevant pull requests.
3. Inspect the package documentation and tests relevant to the task.
4. Register substantive agent sessions using `templates/agent-registration.json`.
5. Confirm the task scope and identify decisions requiring human approval.
6. Before broad, sensitive, architectural, or irreversible actions, create an intent record.
7. Implement only the authorized scope on a feature branch.
8. Run relevant tests and checks; record exact commands and results.
9. Update active threads and create a handoff for significant work.

## Governance boundaries
Development governance, ASFDK foundation, ASFDK harness, and ASFDK MCP are distinct layers. AgentOS is an execution environment, not an authority source. Model output is proposed intent, not permission.

## Escalation
Stop and escalate to Joshua W. Dorsey, Sr. when scope, architecture, provider selection, security, privacy, deployment, persistence, or external integrations require a decision.
