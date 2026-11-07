---
name: repo-governance-setup
description: NLT-Pi repository governance setup and validation procedure (SOP-NLT-002). Defines the required governance artifacts (AGENTS.md, CLAUDE.md, GOVERNANCE.md, governance.yaml, governance.json, NLT-DEV-OTOI.md, REVIEW.md, nltotoi.json), the .noltotoi governance namespace, agent configuration, records, templates, GitHub intake templates, and validation; plus evidence-record conventions and upstream template change management.
---

# SOP-NLT-002 — NLT-Pi Repository Governance Setup

**Version:** 1.1.0
**Scope:** Governance scaffolding and validation for this repository
**Authority:** Joshua W. Dorsey, Sr.

## Purpose
Define NLT-Pi's repository-specific governance implementation. The public `.github` repository supplies minimum governance requirements and reusable templates for public repositories. NLT-Pi adopts the applicable baseline and adapts it to this repository's architecture, risks, tools, and operational requirements.

The public templates are a minimum baseline, not a complete implementation and not a demand for unchanged duplication. Repository-specific controls may extend the baseline where justified by NLT-Pi's architecture, risks, or tooling. Local adaptations are owned here; no downstream sync or automatic upstream propagation is configured.

## Public baseline requirements
The public setup SOP requires every public repository to include or link to the following from its root or `CLAUDE.md`:

- `AGENTS.md`
- `GOVERNANCE.md`
- `governance.yaml`
- `governance.json`

It also expects an Agent Escalation issue template and a pull request template. Organization-supported community health defaults such as `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and `SUPPORT.md` should not be duplicated locally unless a repository-specific override is intentional.

Reference baseline:
- [Public governance setup SOP](https://github.com/NeuroLift-Technologies/.github/blob/main/SOPs/repo-governance-setup.md)
- [Public agent guide](https://github.com/NeuroLift-Technologies/.github/blob/main/AGENTS.md)
- [Public governance principles](https://github.com/NeuroLift-Technologies/.github/blob/main/GOVERNANCE.md)
- [Machine-readable YAML contract](https://github.com/NeuroLift-Technologies/.github/blob/main/governance.yaml)
- [Machine-readable JSON contract](https://github.com/NeuroLift-Technologies/.github/blob/main/governance.json)
- [Public review format](https://github.com/NeuroLift-Technologies/.github/blob/main/REVIEW.md)

## Required NLT-Pi artifacts
- Root: `AGENTS.md`, `CLAUDE.md`, `GOVERNANCE.md`, `governance.yaml`, `governance.json`, `NLT-DEV-OTOI.md`, `REVIEW.md`, `nltotoi.json`.
- Governance namespace: `.nltotoi/`.
- Agent configuration: `.claude/`.
- Records: `docs/active-threads.md`, `docs/agent-log/`, `docs/escalations/`.
- Templates: `templates/`.
- GitHub intake: `.github/ISSUE_TEMPLATE/agent-escalation.md`, `.github/ISSUE_TEMPLATE/governance-proposal.md`, and root `PULL_REQUEST_TEMPLATE.md`.
- Validation: `.nltotoi/scripts/validate-governance.sh` and `.github/workflows/validate-nlt-governance.yml`.

## Procedure
1. Review the applicable public templates and minimum requirements in `.github`.
2. Adapt language, paths, version identifiers, roles, and enforcement claims to NLT-Pi.
3. Record the public baseline source and version in the local manifest and governance index.
4. Preserve distinct ASFDK development, foundation, harness, and MCP responsibilities.
5. Preserve repository-specific controls where they add justified coverage beyond the baseline.
6. Validate manifest paths, required artifacts, source metadata, baseline links, and repository-specific safeguards.
7. Run the repository-local governance validator and relevant repository checks.
8. Review the diff and submit a PR for human approval.

## Evidence-record conventions
Agent registration must not claim OTOI acknowledgment before the agent has explicitly acknowledged it. Handoff records must distinguish tests that passed, failed, were not run, partially passed, or were blocked. Record exact commands and outcomes where available; do not infer results from a boolean default.

## Automation boundary
Only repository-local validation is installed. Do not add organization-wide propagation, compliance scanning, or secret-scanning workflows without explicit review of permissions, dependencies, secrets, and operational assumptions.

## Upstream template change management
When public baseline templates change:
1. Review the change and identify applicable requirements.
2. Compare them with the NLT-Pi local implementation.
3. Determine whether an adaptation is needed; do not copy blindly.
4. Preserve justified project-specific controls.
5. Update local source/version provenance and this SOP when appropriate.
6. Validate and submit a repository PR.

No automatic synchronization is configured. Upstream template changes never silently overwrite local governance.

---

*SOP-NLT-002 v1.1.0 | NeuroLift Technologies | Public baseline ORG-DEV-OTOI-1.0.4, adapted for NLT-Pi*
