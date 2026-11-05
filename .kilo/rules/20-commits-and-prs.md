# Commits and pull requests

## Commit format
```
[AGENT_NAME] type(scope): imperative description
```
Allowed types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `ci`.

Use a stable agent name for Kilo sessions — `[kilo]` — so provenance in the history is
readable. If a named Kilo agent profile did the work, use that profile's name.

## Before pushing
Run the verification sequence in `AGENTS.md` under "Pre-push verification", including its
fresh-clone prerequisites and the conflict-marker check. The commands are listed there and
deliberately not repeated here.

Never skip hooks: no `--no-verify`, no `core.hooksPath` override. If the hook cannot run or
cannot pass, stop, say which step failed and whether your change caused it, and escalate.

## Branches
Never push directly to `main`. Use a feature branch and a pull request. Do not force-push
or rewrite shared history.

## Pull requests
Use the root `PULL_REQUEST_TEMPLATE.md`. Every PR must state:
- scope — one independently reviewable concern,
- architecture and governance impact,
- the tests that actually ran, and their results,
- known limitations,
- decisions still required from the owner.

Keep diffs scoped. No unrelated formatting or refactors. Do not remove functionality
without approval. A review is evidence for the human decision-maker, not a substitute for
approval.

## Secrets
No secrets, credentials, tokens, or private data in source, logs, commits, issues, or
fixtures — including anything written into `kilo.jsonc`.
