# NLT-Pi Governance File Index

**Repository:** NeuroLift-Technologies/nlt-pi  
**Local contract:** NLT-PI-DEV-OTOI-1.0.1  
**Organizational baseline:** ORG-DEV-OTOI-1.0.4  
**Public minimum-requirements and template source:** [NeuroLift-Technologies/.github](https://github.com/NeuroLift-Technologies/.github)

## Governance relationship

The public `.github` repository provides minimum requirements and reusable templates for public repositories. NLT-Pi adopts the applicable baseline and adapts it to its own architecture, risk profile, runtime, and tooling. This repository owns its adapted implementation. The baseline is not a requirement to duplicate generic templates unchanged, and no automatic propagation is configured.

## Public baseline references

| Artifact | Purpose |
|---|---|
| [Public governance SOP](https://github.com/NeuroLift-Technologies/.github/blob/main/SOPs/repo-governance-setup.md) | Minimum setup requirements for public repositories |
| [AGENTS.md](https://github.com/NeuroLift-Technologies/.github/blob/main/AGENTS.md) | Public agent contribution baseline |
| [GOVERNANCE.md](https://github.com/NeuroLift-Technologies/.github/blob/main/GOVERNANCE.md) | Public governance principles |
| [governance.yaml](https://github.com/NeuroLift-Technologies/.github/blob/main/governance.yaml) | Machine-readable organizational contract |
| [governance.json](https://github.com/NeuroLift-Technologies/.github/blob/main/governance.json) | JSON representation of the organizational contract |
| [REVIEW.md](https://github.com/NeuroLift-Technologies/.github/blob/main/REVIEW.md) | Public review format |
| [PULL_REQUEST_TEMPLATE.md](https://github.com/NeuroLift-Technologies/.github/blob/main/PULL_REQUEST_TEMPLATE.md) | Public PR baseline |

## Core
| Path | Purpose |
|---|---|
| `GOVERNANCE.md` | Public principles mapped to NLT-Pi's local implementation |
| `governance.yaml` / `governance.json` | Repository-adapted machine-readable baseline |
| `NLT-DEV-OTOI.md` | Repository governance contract |
| `AGENTS.md` | Agent gateway and architecture boundaries |
| `CLAUDE.md` | Claude Code session directives |
| `REVIEW.md` | Repository-specific review format |
| `nltotoi.json` | Local machine-readable manifest and required-file inventory |
| `docs/active-threads.md` | Current work state |
| `docs/agent-log/` | Registrations, handoffs, and intent records |
| `docs/escalations/` | Escalation and incident records |

## Templates
Registration, handoff, escalation, intent, review, and commit-message templates live in `templates/`. They are adapted for NLT-Pi; the public baseline is not copied wholesale.

## Claude Code
`.claude/settings.json` wires a non-blocking SessionStart hook. `.claude/agents/`, `.claude/skills/`, and `.claude/commands/` provide repository-adapted role guidance and workflows.

## Governance layers
1. Development governance is defined by this repository's documents.
2. ASFDK foundation supplies SDK-level governance primitives.
3. ASFDK harness enforces agent-level authorization around runtime actions.
4. ASFDK MCP governs external integration surfaces; it is not a mandatory hop for every internal operation.

## Automation
`.github/workflows/validate-nlt-governance.yml` validates repository-local governance artifacts, baseline provenance, and selected template safeguards. No org-wide propagation workflow is installed: downstream adaptations are locally owned and are not silently overwritten.

## Repository SOPs
| Path | Purpose |
|---|---|
| `SOPs/new-agent-onboarding.md` | Agent onboarding and session protocol |
| `SOPs/repo-governance-setup.md` | Local governance setup and validation |
| `SOPs/incident-response.md` | Agent and governance incident response |

## Repository agent profiles
| Path | Purpose |
|---|---|
| `agents/README.md` | Agent profile index and authority limitations |
| `agents/nlt-governance-steward.md` | Read-only governance audit |
| `agents/nlt-code-reviewer.md` | Read-only code/security review |
| `agents/nlt-implementation-agent.md` | Scoped implementation workflow |

## GitHub integration
| Path | Purpose |
|---|---|
| `.github/ISSUE_TEMPLATE/agent-escalation.md` | Sanitized escalation intake; security-sensitive reports use private reporting |
| `.github/ISSUE_TEMPLATE/governance-proposal.md` | Governance change proposal |
| `PULL_REQUEST_TEMPLATE.md` | NLT-Pi PR checklist |
| `.github/workflows/validate-nlt-governance.yml` | Repository-local governance validation |
