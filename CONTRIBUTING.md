# Contributing to pi

This guide exists to save both sides time.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

If you use an agent, run it from the `pi-mono` root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## Contribution Gate

All issues and PRs from new contributors are auto-closed by default.

Issues submitted Friday through Sunday are not reviewed. If something is urgent, ask on Discord: https://discord.com/invite/3cU7Bz4UPx

Maintainers review auto-closed issues daily and reopen worthwhile ones. Issues that do not meet the quality bar below will not be reopened or receive a reply.

Approval happens through maintainer replies on issues:

- `lgtmi`: your future issues will not be auto-closed
- `lgtm`: your future issues and PRs will not be auto-closed

`lgtmi` does not grant rights to submit PRs. Only `lgtm` grants rights to submit PRs.

## Quality Bar For Issues

If you open an issue, you must use one of the two GitHub issue templates.

If you open an issue, keep it short, concrete, and worth reading.

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice.
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

If the issue is real and written well, a maintainer may reopen it, reply `lgtmi`, or reply `lgtm`.

## Blocking

If you ignore this document twice, or if you spam the tracker with agent-generated issues, your GitHub account will be permanently blocked.

If you send a large volume of issues through automation, your GitHub account will be permanently blocked. No taksies backsies.

## Before Submitting a PR

Do not open a PR unless you have already been approved with `lgtm`.

Before submitting a PR:

```bash
npm run check
./test.sh
```

Both must pass.

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you are adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Philosophy

pi's core is minimal. If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.

## Questions?

Ask on [Discord](https://discord.com/invite/nKXTsAcmbT).
