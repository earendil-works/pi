---
name: github-work
description: Work on GitHub issues and pull requests of this repo. Use when asked to investigate, analyze, fix, or review an issue or PR, and when asked to wrap up such work (changelog, comment, commit, push, close).
---

# Working on GitHub issues and PRs

The repo's prompt templates in `.pi/prompts/` (two directories above this skill) define the workflow. Read the matching template in full and follow it. Where a template says `$ARGUMENTS` or `$@`, substitute the issue or PR number or URL from the request, and any extra instructions the user gave.

| Request | Template |
|---|---|
| Investigate, analyze, or fix an issue | `.pi/prompts/is.md` |
| Review a pull request | `.pi/prompts/pr.md` |
| Wrap up issue or PR work: changelog, final comment, commit, push, close | `.pi/prompts/wr.md` |

Rules:

- `is.md` analyzes and proposes only. Implement only when the user asks for it, then keep following AGENTS.md (checks, tests, changelog rules).
- `pr.md` never checks out or switches to the PR branch.
- Run `wr.md` only when the user asks to wrap up, commit, or push. Post at most one final GitHub comment per session, ending with the exact disclaimer line it specifies.
- When a request spans several steps, for example "fix issue X and wrap it up", read every template involved before starting.
