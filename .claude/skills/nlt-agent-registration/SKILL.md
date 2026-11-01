---
name: nlt-agent-registration
description: Creates an auditable NLT-Pi agent session registration.
---

# Agent Registration

At the start of substantive work, create a registration from `templates/agent-registration.json` under `docs/agent-log/registrations/YYYY-MM-DD-agent.json`.

Use actual values for agent/platform, model/tool version if known, ISO 8601 timestamp with offset, task entry point, repository, branch, capabilities, and limitations. Set `acknowledged_otoi` to true only after reading `NLT-DEV-OTOI.md`. Do not invent a session identifier or claim capabilities you do not have. Never include credentials.
