---
description: Create an NLT-Pi agent registration record
argument-hint: "[optional session identifier]"
---

Read `NLT-DEV-OTOI.md` and create a registration using `templates/agent-registration.json`. Populate only facts known in this session. Use an ISO 8601 timestamp with offset and the current repository/branch. Save to `docs/agent-log/registrations/YYYY-MM-DDTHHMMSSZ-agent-name-<unique-session-id>.json`. Use the supplied session identifier when available; otherwise generate a UUID. Check that the destination does not already exist before writing. If it exists, generate a new unique suffix; never overwrite or replace an existing registration. Do not commit unless explicitly requested. Report the file path and any unavailable fields.
