# NLT-Pi Review Standard

**Governed by:** NLT-PI-DEV-OTOI-1.0.1  
**Organizational baseline:** ORG-DEV-OTOI-1.0.4  
**Public template source:** [NeuroLift-Technologies/.github](https://github.com/NeuroLift-Technologies/.github)  
**Applies to:** Code, architecture, security, governance, documentation, and agent behavior reviews.

## Review metadata
- **Reviewer:** [agent / person]
- **Date:** [ISO 8601]
- **Review type:** [Code | Architecture | Security | Governance | Documentation]
- **Scope:** [PR, commit, files, or behavior]
- **Local contract:** NLT-PI-DEV-OTOI-1.0.1
- **Organizational baseline:** ORG-DEV-OTOI-1.0.4

> Coding agents making review comments must sign them with the agent comment signature from `templates/agent-comment.md`. Applies to any coding agent (Cline, Kilo, OpenCode, Codex, Claude Code, or similar).

## Pre-review checklist
- [ ] Read the public governance baseline and NLT-Pi local OTOI.
- [ ] Read relevant architecture and package documentation.
- [ ] Checked active threads and related decisions.
- [ ] Identified the trust boundaries and affected governance layer.
- [ ] Reviewed the full diff, not only the summary.

## Summary
[Concise assessment and overall risk.]

## Findings

### Critical
| Location | Finding | Scenario | Impact | Required remediation |
|---|---|---|---|---|
| — | None identified / finding | — | — | — |

### High
| Location | Finding | Scenario | Impact | Required remediation |
|---|---|---|---|---|
| — | None identified / finding | — | — | — |

### Medium / Low
- **Location:** [exact path and line]
- **Finding:** [concise issue]
- **Scenario:** [specific trigger, precondition, or state that causes the failure]
- **Impact:** [observable consequence]
- **Required remediation:** [concrete action]

Every finding must identify the concrete trigger, precondition, or state that produces the stated impact. Do not use a speculative impact without labeling it as a hypothesis and stating what evidence is missing. Preserve exact locations and actionable remediation.

## Architecture and governance
- [ ] Development, harness, and MCP governance boundaries remain distinct.
- [ ] Model output is treated as proposed intent, not authorization.
- [ ] Capability grants are explicit and scoped.
- [ ] Human approval and escalation paths remain intact.
- [ ] Provenance and auditability are preserved.
- [ ] Public minimum governance requirements are satisfied.
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
