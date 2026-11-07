# .agents — NLT-Pi Agent Skills

Project-level Agent Skills for Pi (the NLT Coding Agent). Pi discovers project skills in `.agents/skills/` at the repository root (and in `.agents/skills/` directories of working-directory ancestors, stopping at the repository root). Each skill is a directory containing `SKILL.md` in the Agent Skills format: YAML frontmatter with `name` and `description`, followed by the instruction body.

## Skills

| Skill | Source | Purpose |
|---|---|---|
| `nlt-code-reviewer` | `agents/nlt-code-reviewer.md` | Read-only code and security review. |
| `nlt-governance-steward` | `agents/nlt-governance-steward.md` | Read-only governance review and audit. |
| `nlt-implementation-agent` | `agents/nlt-implementation-agent.md` | Scoped implementation workflow. |
| `incident-response` | `SOPs/incident-response.md` (SOP-NLT-003) | Agent and governance incident response. |
| `new-agent-onboarding` | `SOPs/new-agent-onboarding.md` (SOP-NLT-001) | Agent onboarding procedure. |
| `repo-governance-setup` | `SOPs/repo-governance-setup.md` (SOP-NLT-002) | Repository governance setup and validation. |
| `agent-registration` | `templates/agent-registration.json` | Agent session registration template. |
| `commit-message` | `templates/commit-message.md` | Commit message format. |
| `escalation` | `templates/escalation.md` | Escalation record template. |
| `handoff-record` | `templates/handoff-record.json` | Handoff record template. |
| `intent-log` | `templates/intent-log.md` | Intent record template. |
| `review-record` | `templates/review-record.md` | Review record template. |
| `vercel-mcp` | (new guidance) | Guidance for connecting the Vercel MCP server to Pi. |
| `rivet-mcp` | (new guidance) | Guidance for connecting the Rivet MCP server to Pi. |

The original documents in `agents/` and `SOPs/` are retained: they are required governance artifacts tracked by `nltotoi.json` and `validate-governance.sh`. These skills are loadable copies of the same guidance; they change no policy, grant no permissions, and override no human approval.
