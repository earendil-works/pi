# NLT-Pi Governance File Index

**Repository:** NeuroLift-Technologies/nlt-pi  
**Contract:** NLT-PI-DEV-OTOI-1.0.0  
**Template source:** NeuroLift-Technologies/.github-private (adapted locally)

## Core
| Path | Purpose |
|---|---|
| `NLT-DEV-OTOI.md` | Repository governance contract |
| `AGENTS.md` | Agent gateway and architecture boundaries |
| `CLAUDE.md` | Claude Code session directives |
| `REVIEW.md` | Review format |
| `nltotoi.json` | Machine-readable manifest |
| `docs/active-threads.md` | Current work state |
| `docs/agent-log/` | Registrations, handoffs, and intent records |
| `docs/escalations/` | Escalation and incident records |

## Templates
Registration, handoff, escalation, intent, review, and commit message templates live in `templates/`.

## Claude Code
`.claude/settings.json` wires a non-blocking SessionStart hook. `.claude/agents/`, `.claude/skills/`, and `.claude/commands/` provide repository-adapted role guidance and workflows.

## Governance layers
1. Development governance is defined by this repository's documents.
2. ASFDK foundation supplies SDK-level governance primitives.
3. ASFDK harness enforces agent-level authorization around runtime actions.
4. ASFDK MCP governs external integration surfaces; it is not a mandatory hop for every internal operation.

## Automation
`.github/workflows/validate-nlt-governance.yml` validates repository-local governance artifacts. No org-wide propagation workflow is installed: downstream adaptations are locally owned and are not silently overwritten.
