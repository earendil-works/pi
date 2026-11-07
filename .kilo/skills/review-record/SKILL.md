---
name: review-record
description: NLT-Pi review record template. Reviews follow REVIEW.md. Record reviewer, date, review type, scope/PR, base/head, summary, findings by severity (Critical, High, Medium/Low), governance and architecture checks, verification commands and outcomes, verdict (APPROVED | CHANGES REQUESTED | BLOCKED), and handoff notes.
---

# NLT-Pi Review Record

**Reviewer:**
**Date:** [ISO 8601]
**Review type:** [Code | Architecture | Security | Governance | Documentation]
**Scope / PR:**
**Base / head:**

## Summary
[Evidence-based summary.]

## Findings
### Critical
- None / [finding with file and line]

### High
- None / [finding with file and line]

### Medium / Low
- [Finding or observation]

## Governance and architecture
- [ ] Development, harness, and MCP boundaries remain distinct.
- [ ] Model output is not treated as authorization.
- [ ] Capability grants are explicit and scoped.
- [ ] Human approval and escalation remain available.
- [ ] Provenance and auditability are preserved.
- [ ] No secrets or unapproved integrations.

## Verification
[Exact commands and outcomes; explicitly state what was not run.]

## Verdict
[APPROVED | CHANGES REQUESTED | BLOCKED]

## Handoff
[Outstanding work, blockers, and next action.]
