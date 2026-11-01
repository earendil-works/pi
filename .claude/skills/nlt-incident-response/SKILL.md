---
name: nlt-incident-response
description: Guides response to unauthorized agent actions, secrets exposure, or ASFDK bypass.
---

# Incident Response

If an agent may have exceeded authority, exposed credentials, bypassed governance, or modified protected systems:
1. Stop further actions and preserve evidence.
2. Identify affected commits, files, services, credentials, and data.
3. If credentials are exposed, treat them as compromised and escalate immediately for revocation/rotation.
4. Do not perform destructive history rewriting, force-push, or production remediation without explicit human direction.
5. Record timeline, impact, containment, root cause, and prevention in `docs/escalations/`.
6. Escalate to Joshua W. Dorsey, Sr. using the escalation template.

Prefer safe containment and human-led remediation. Never recommend an irreversible recovery operation as an automatic agent action.
