---
name: incident-response
description: NLT-Pi agent and governance incident response procedure (SOP-NLT-003). Covers trigger conditions (credential or sensitive-data exposure, unauthorized tool execution, ASFDK bypass, unapproved boundary changes, agent action outside scope or authorization), immediate response steps, severity levels, and recovery requiring explicit human direction.
---

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
1. Stop further agent actions; preserve logs, diffs, commits, and relevant tool evidence in an access-controlled location.
2. Determine affected code, credentials, services, data, and trust boundaries without copying sensitive evidence into public records.
3. Escalate immediately for critical/high impact or uncertainty.
4. If credentials may be exposed, treat them as compromised and have the authorized owner revoke/rotate them.
5. Do not autonomously force-push, rewrite shared history, delete evidence, or perform production remediation.
6. Record sensitive timeline, impact, containment, root cause, and prevention details in an access-controlled private incident record. Do not place vulnerability details, exploit steps, secrets, or private data in this public repository.
7. Report security vulnerabilities through GitHub private vulnerability reporting / Security Advisories when available. If unavailable, obtain the repository owner's established private reporting route; never use a public issue as a substitute.
8. Create or update a public GitHub issue only after the repository owner confirms that a sanitized status summary is safe to disclose.
9. Review the incident and identify whether code, tests, policy, or instructions require an approved change.

## Severity
- **Critical:** credential exposure, production impact, unauthorized external access, or governance bypass with material risk.
- **High:** authorization boundary failure, data integrity impact, or significant scope violation.
- **Medium:** process failure with limited impact, such as missing records or unreviewed changes.
- **Low:** minor deviation with no material impact.

## Recovery
Recovery actions affecting credentials, production, data, branch history, or external services require explicit human direction. Prefer reversible containment and preserve evidence.
