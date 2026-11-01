# SOP-NLT-003 — NLT-Pi Agent and Governance Incident Response

**Version:** 1.0.0  
**Authority:** Joshua W. Dorsey, Sr.

## Trigger conditions
- Suspected credential or sensitive-data exposure.
- Unauthorized tool execution or capability use.
- ASFDK foundation, harness, or MCP bypass.
- Unapproved changes to security, privacy, deployment, or persistence boundaries.
- Agent action outside confirmed scope or human authorization.

## Immediate response
1. Stop further agent actions; preserve logs, diffs, commits, and relevant tool evidence.
2. Determine affected code, credentials, services, data, and trust boundaries.
3. Escalate immediately for critical/high impact or uncertainty.
4. If credentials may be exposed, treat them as compromised and have the authorized owner revoke/rotate them.
5. Do not autonomously force-push, rewrite shared history, delete evidence, or perform production remediation.
6. Record timeline, impact, containment, root cause, and prevention in `docs/escalations/`.
7. Review the incident and identify whether code, tests, policy, or instructions require an approved change.

## Severity
- **Critical:** credential exposure, production impact, unauthorized external access, or governance bypass with material risk.
- **High:** authorization boundary failure, data integrity impact, or significant scope violation.
- **Medium:** process failure with limited impact, such as missing records or unreviewed changes.
- **Low:** minor deviation with no material impact.

## Recovery
Recovery actions affecting credentials, production, data, branch history, or external services require explicit human direction. Prefer reversible containment and preserve evidence.
