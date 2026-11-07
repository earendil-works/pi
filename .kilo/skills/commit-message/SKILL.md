---
name: commit-message
description: NLT-Pi commit message format. Use `[AGENT_NAME] type(scope): imperative description` with allowed types feat, fix, docs, refactor, chore, test, ci. Do not include secrets, credentials, or sensitive data. Keep each commit focused on one independently reviewable concern.
---

# NLT-Pi Commit Message Format

`[AGENT_NAME] type(scope): imperative description`

Allowed types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `ci`.

Examples:
- `[Claude] feat(runtime): add governed tool dispatch`
- `[Codex] fix(harness): reject unapproved capability`
- `[Copilot] docs(governance): clarify MCP boundary`

Do not include secrets, credentials, or sensitive data in commit messages. Keep each commit focused on one independently reviewable concern. Deliver agent-authored changes through a pull request; do not commit unless the user explicitly requests committing; never push directly to `main` or force-push.
