# NLT-Pi Intent Record

**Date:** 2026-11-01T22:36:00-05:00  
**Agent / session:** ChatGPT / chatgpt-2026-11-01-nlt-pi-public-governance-alignment  
**Branch:** fix/public-governance-baseline-alignment  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Update the public NLT-Pi repository's governance documents, machine-readable manifests, setup SOP, issue templates, agent evidence templates, governance validator, and validation workflow to align with the public minimum requirements and templates in NeuroLift-Technologies/.github.

## Rationale
The audit found that NLT-Pi incorrectly named .github-private as its template source, lacked local or linked copies of the public SOP's required governance artifacts, retained inherited upstream contribution restrictions in issue templates after those gates had been removed, and used evidence defaults that could imply unperformed acknowledgment or ambiguous test outcomes.

## Risks and trust boundaries
Documentation and repository-governance configuration only. No runtime execution, ASFDK authorization logic, credentials, external integrations, deployment, persistence, or production controls are changed. Public issue templates must not invite disclosure of vulnerabilities or sensitive data.

## Alternatives considered
1. Replace NLT-Pi governance with generic templates: rejected because NLT-Pi requires repository-specific ASFDK, runtime, and AgentOS controls.
2. Add source links without local baseline artifacts: rejected because the public setup SOP requires the four baseline governance artifacts to be present or linked from root or CLAUDE.md.
3. Automatically synchronize public templates: rejected because local adaptations must remain repository-owned and must not be overwritten silently.

## Human approval / escalation
The repository owner explicitly authorized this audit remediation and PR creation in the current conversation. The PR remains subject to human review and merge approval.

## Outcome
Implementation is being prepared on a feature branch. Tests and governance validation must be reported only after actual execution or CI results.
