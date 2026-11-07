# NLT-Pi Governance

NLT-Pi adopts the minimum governance requirements and reusable templates maintained in the [NeuroLift Technologies public governance repository](https://github.com/NeuroLift-Technologies/.github). The public baseline is ORG-DEV-OTOI-1.0.4. This document explains how those public principles are implemented in this repository.

The public templates are minimum requirements, not a complete implementation and not a demand for unchanged duplication. NLT-Pi adapts them to its runtime architecture, security boundaries, and engineering workflow. Local controls may extend the baseline but must not silently weaken or contradict it.

## Principles

- **Human authority remains final.** Model output and tool availability do not create authorization.
- **Capability does not equal authority.** Every capability is scoped by explicit permission and applicable enforcement.
- **Escalate, do not guess.** Unclear scope, authority, security, or architecture decisions are returned to the human decision-maker.
- **Transparency and provenance.** Agent contributions, decisions, tests, limitations, and handoffs must be accurately recorded.
- **Agent comment attribution.** Any comment a coding agent makes using the account owner's account must carry an explicit agent signature (`templates/agent-comment.md`) so coding-agent authorship is distinguishable from human authorship. Applies to any coding agent (Cline, Kilo, OpenCode, Codex, Claude Code, or similar).
- **Least privilege and safe failure.** Unknown or unresolved authorization must not be treated as permission.

## Public baseline

NLT-Pi adopts the applicable requirements from the public organizational governance resources:

- [Public agent guide](https://github.com/NeuroLift-Technologies/.github/blob/main/AGENTS.md)
- [Public governance principles](https://github.com/NeuroLift-Technologies/.github/blob/main/GOVERNANCE.md)
- [Machine-readable YAML contract](https://github.com/NeuroLift-Technologies/.github/blob/main/governance.yaml)
- [Machine-readable JSON contract](https://github.com/NeuroLift-Technologies/.github/blob/main/governance.json)
- [Public repository setup SOP](https://github.com/NeuroLift-Technologies/.github/blob/main/SOPs/repo-governance-setup.md)
- [Public review format](https://github.com/NeuroLift-Technologies/.github/blob/main/REVIEW.md)

## NLT-Pi implementation

The repository-specific implementation is defined by:

- `NLT-DEV-OTOI.md`: local developer contract and authority model.
- `AGENTS.md` and `CLAUDE.md`: agent entry points and working instructions.
- `governance.yaml` and `governance.json`: machine-readable adaptation of the public minimum baseline for this repository.
- `nltotoi.json`: local artifact inventory, source provenance, and discovery metadata.
- `REVIEW.md` and `PULL_REQUEST_TEMPLATE.md`: repository-specific review and PR requirements.
- `SOPs/`, `templates/`, `agents/`, and `.nltotoi/`: repository-specific procedures, evidence formats, role guidance, and validation.

NLT-Pi's governance architecture preserves distinct development governance, ASFDK foundation, ASFDK harness, and ASFDK MCP responsibilities. AgentOS is an execution environment, not an authority source.

## Maintenance and change control

The public baseline is maintained in the public `.github` repository. NLT-Pi owns its adapted local implementation. Upstream template changes must be reviewed and deliberately incorporated; they do not automatically overwrite local files.

Repository-specific governance changes require explicit repository-owner approval. Changes to organization-wide policy must be proposed through the organizational governance process. This repository cannot unilaterally amend the organizational contract.

## Authority

Joshua W. Dorsey, Sr. is the final authority for NLT-Pi architecture, security boundaries, provider strategy, deployment, data retention, UX direction, and project scope. Reviews and agent attestations provide evidence; they do not replace human approval.

**Capability does not equal authority. Escalate, do not guess.**
