# SOP-NLT-002 — NLT-Pi Repository Governance Setup

**Version:** 1.0.0  
**Scope:** Governance scaffolding and validation for this repository  
**Template source:** NeuroLift-Technologies/.github-private

## Purpose
Define the repository-specific governance baseline. Organization templates are adapted locally; no downstream sync or automatic upstream propagation is configured.

## Required artifacts
- Root: `AGENTS.md`, `CLAUDE.md`, `NLT-DEV-OTOI.md`, `REVIEW.md`, `nltotoi.json`.
- Governance namespace: `.nltotoi/`.
- Agent configuration: `.claude/`.
- Records: `docs/active-threads.md`, `docs/agent-log/`, `docs/escalations/`.
- Templates: `templates/`.
- Validation: `.nltotoi/scripts/validate-governance.sh` and `.github/workflows/validate-nlt-governance.yml`.

## Procedure
1. Review the canonical organization templates in `.github-private`.
2. Adapt language, paths, version identifiers, roles, and enforcement claims to NLT-Pi.
3. Preserve distinct ASFDK development, foundation, harness, and MCP responsibilities.
4. Validate manifest paths and required artifacts.
5. Run the repository-local governance validator.
6. Review the diff and submit a PR for human approval.

## Automation boundary
Only repository-local validation is installed. Do not add organization-wide propagation, compliance scanning, or secret-scanning workflows without explicit review of permissions, dependencies, secrets, and operational assumptions.
