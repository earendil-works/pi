---
name: nlt-commit-format
description: Formats NLT-Pi commits using the repository OTOI convention.
---

# Commit Format

Use `[AGENT_NAME] type(scope): imperative description`.

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `ci`.

Examples:
- `[Claude] feat(runtime): add governed dispatch boundary`
- `[Codex] fix(harness): reject unapproved capability`
- `[Copilot] docs(governance): clarify MCP boundary`

Do not commit unless asked. Never push directly to `main`, force-push, or rewrite shared history.
