# NLT-Pi Review Standard

**Governed by:** NLT-PI-DEV-OTOI-1.0.0  
**Applies to:** Code, architecture, security, governance, documentation, and agent behavior reviews.

## Review metadata
- **Reviewer:** [agent / person]
- **Date:** [ISO 8601]
- **Review type:** [Code | Architecture | Security | Governance | Documentation]
- **Scope:** [PR, commit, files, or behavior]
- **Base / head:** [refs or SHAs]

## Pre-review checklist
- [ ] Read `NLT-DEV-OTOI.md` and `AGENTS.md`.
- [ ] Read relevant architecture and package documentation.
- [ ] Checked active threads and related decisions.
- [ ] Identified the trust boundaries and affected governance layer.
- [ ] Reviewed the full diff, not only the summary.

## Summary
[Concise assessment and overall risk.]

## Findings

### Critical
| Location | Finding | Impact | Required remediation |
|---|---|---|---|
| — | None identified / finding | — | — |

### High
| Location | Finding | Impact | Required remediation |
|---|---|---|---|
| — | None identified / finding | — | — |

### Medium / Low
- [Non-blocking issue or observation.]

## Architecture and governance
- [ ] Development, harness, and MCP governance boundaries remain distinct.
- [ ] Model output is treated as proposed intent, not authorization.
- [ ] Capability grants are explicit and scoped.
- [ ] Human approval and escalation paths remain intact.
- [ ] Provenance and auditability are preserved.
- [ ] No unapproved provider, infrastructure, persistence, or external integration decision.
- [ ] No credentials or sensitive data exposed.

## Verification
List exact commands and outcomes. Mark tests as not run when they were not run. Separate static inspection from executed tests.

## Verdict
**Status:** [APPROVED | CHANGES REQUESTED | BLOCKED]

**Rationale:** [Evidence-based decision.]

## Handoff
- Completed:
- Remaining:
- Blockers:
- Decisions required:
- Next action:

---
Reviews support human decision-making; they do not replace human approval.
