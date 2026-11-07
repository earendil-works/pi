# Agent Pull Request Template

> **How to create PR bodies:** This template is applied via `gh pr edit --body-file /tmp/pr_body.md` where the body is written using `cat > /tmp/pr_body.md << 'HEREDOC'` (single-quoted heredoc prevents bash from interpreting special characters like `[ORG-DEV-OTOI-1.0.4]` and arrows `→`). Do not use `gh pr create --body "…"` directly as bash will interpret markdown/JSON characters as commands.

**Purpose:** Repository-adapted pull request template for NLT-Pi contributions, aligned with the NeuroLift Technologies public governance baseline.

**Governed by:** `governance.yaml` (ORG-DEV-OTOI-1.0.4)

> **Start here:** [`governance.yaml`](governance.yaml) is the authoritative machine-readable contract and [`AGENTS.md`](AGENTS.md) is the agent-facing guide. If anything in this template disagrees with `governance.yaml`, `governance.yaml` wins.

## PR Metadata

**Agent:** [Name / platform]
**Branch:** [feature/...]
**Working repo:** [Repository name]
**PR Type:** [feat | fix | docs | refactor | chore | test | ci]
**Governance Version:** ORG-DEV-OTOI-1.0.4

---

## Change summary
[What changed and why.]

## Scope
- [ ] Runtime / SDK
- [ ] ASFDK development governance
- [ ] ASFDK foundation integration
- [ ] ASFDK harness integration
- [ ] ASFDK MCP integration
- [ ] AgentOS execution boundary
- [ ] Documentation / governance

## Reviewability
- [ ] This PR addresses one focused, independently reviewable concern.
- [ ] Any broader scope is explained below.

## Architecture and trust-boundary impact
[State which layers and execution paths are affected. Confirm whether ownership boundaries changed.]

## Verification
- Commands run:
- Tests passed:
- Tests failed:
- Tests not run:
- Known limitations:

## Governance
- Repository adaptation contract: `NLT-PI-DEV-OTOI-1.0.1`.
- [ ] No secrets or sensitive data added.
- [ ] No unapproved external integration/provider/deployment decision.
- [ ] Model output remains proposed intent, not authorization.
- [ ] Human approval/escalation requirements are preserved.
- [ ] Applicable public baseline requirements are satisfied.
- [ ] Active threads and handoff records updated where applicable.

## Commit format
Agent-authored commits must follow:
`[AGENT_NAME] type(scope): imperative description`

Allowed types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `ci`.

## Contributing agent
Complete this block when an AI agent materially contributes to the PR. Use actual session details; write `Unknown` or `Not recorded` rather than guessing. Human contributors may identify themselves here when useful.

- **Agent name / identifier:**
- **Platform / runtime:**
- **Model and version:**
- **Agent or session ID:**
- **Contribution date (ISO 8601, with timezone):**
- **Working branch:**
- **OTOI / governance contract acknowledged:** [ ] Yes [ ] No
- **Registration record:** [path or link, if created]
- **Handoff record:** [path or link, if created]
- **Contribution summary:** [What the agent actually changed or investigated.]
- **Verification performed by the agent:** [Commands/tests actually run; distinguish from CI.]
- **Known limitations / unverified items:**
- **Agent attestation:** I have accurately represented my contribution, capabilities, and verification. This attestation records provenance; it does not constitute authorization or human approval.
- **Agent comment signature:** Any comments made on this PR or related issues by a coding agent must carry the agent comment signature from `templates/agent-comment.md`. Applies to any coding agent (Cline, Kilo, OpenCode, Codex, Claude Code, or similar).

## Human decisions required
[List any decisions still pending. If none, say none.]
