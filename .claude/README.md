# NLT-Pi Claude Code Governance

Repository-adapted Claude Code configuration. Templates originate in `.github-private`, but this copy is owned by NLT-Pi and may be modified locally. No automatic propagation is configured.

## Contents
- `settings.json`: SessionStart hook and conservative permissions.
- `hooks/session-start.sh`: displays governance entry points and checks required files.
- `agents/`: governance steward, code reviewer, and implementation agent.
- `skills/`: OTOI, registration, handoff, escalation, intent, commit, incident response.
- `commands/`: registration, handoff, escalation, intent log, governance check.

Project-specific engineering authority and architecture boundaries are defined in root `AGENTS.md` and `NLT-DEV-OTOI.md`.
