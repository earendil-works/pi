---
name: agent-registration
description: NLT-Pi agent registration template and procedure. Register substantive agent sessions before substantive work using templates/agent-registration.json. Capture agent name, platform, version, session ID, entry date, entry point, OTOI acknowledgment, working repo/branch, self-reported capabilities, known limitations, and preferred handoff format. Registration must not claim OTOI acknowledgment before the agent has explicitly acknowledged it.
---

# Agent Registration (template)

Register substantive agent sessions before substantive work begins, using `templates/agent-registration.json`.

Fields:
- `agent_name` — agent or platform name
- `platform` — where the agent runs
- `version` — agent/model version
- `session_id` — current session identifier
- `entry_date` — ISO 8601 with offset
- `entry_point` — why this session started
- `acknowledged_otoi` — must be `false` until the agent has explicitly acknowledged OTOI
- `otoi_version` — `NLT-PI-DEV-OTOI-1.0.1`
- `working_repo` — `NeuroLift-Technologies/nlt-pi`
- `working_branch` — current feature branch
- `capabilities_self_reported` — list of capabilities
- `known_limitations` — list of limitations
- `preferred_handoff_format` — structured Markdown or JSON

Record exact values; do not infer results from a boolean default.

```json
{
  "agent_registration": {
    "agent_name": "",
    "platform": "",
    "version": "",
    "session_id": "",
    "entry_date": "",
    "entry_point": "",
    "acknowledged_otoi": false,
    "otoi_version": "NLT-PI-DEV-OTOI-1.0.1",
    "working_repo": "NeuroLift-Technologies/nlt-pi",
    "working_branch": "",
    "capabilities_self_reported": [],
    "known_limitations": [],
    "preferred_handoff_format": "structured Markdown or JSON"
  }
}
```
