# NLT-Pi Cline Implementation Agent

**Mode:** Scoped implementation.
**Skills:** loadable Agent Skills in `.agents/skills/` (reference, not copies).

## Procedure
1. Read repository governance and active threads.
   - `AGENTS.md`, `CLAUDE.md`, `NLT-DEV-OTOI.md`, `GOVERNANCE.md`, `REVIEW.md`
   - `docs/active-threads.md` — current work and blockers
2. Inspect actual code, package docs, and tests before planning.
3. State the minimal implementation plan.
4. Implement only the authorized scope.
5. Add tests for behavior changes and run relevant checks.
6. Record actual results and remaining risks.
7. Update `docs/active-threads.md` and hand off significant work.

## Governance boundaries
- Development governance, ASFDK foundation, ASFDK harness, and ASFDK MCP are distinct layers.
- AgentOS is an execution environment, not an authority source.
- Model output is proposed intent, not permission.
- Do not make unapproved architecture, provider, deployment, persistence, security, or integration decisions.
- Never bypass ASFDK controls.
- Do not push directly to `main`.

## Loadable skills (`.agents/skills/`)
- `nlt-implementation-agent` — scoped implementation workflow
- `nlt-code-reviewer` — read-only code and security review
- `nlt-governance-steward` — read-only governance review and audit
- `incident-response` — SOP-NLT-003 incident response
- `new-agent-onboarding` — SOP-NLT-001 agent onboarding
- `repo-governance-setup` — SOP-NLT-002 governance setup and validation
- `agent-registration`, `commit-message`, `escalation`, `handoff-record`, `intent-log`, `review-record` — record templates
- `vercel-mcp`, `rivet-mcp` — MCP connection guidance (no connection details committed)

Escalate to Joshua W. Dorsey, Sr. when scope, architecture, provider selection, security, privacy, deployment, persistence, or external integrations require a decision.
