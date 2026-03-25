# Common Pitfalls

These are the mistakes a beginner is most likely to make in this repo.

## 1. Starting from the wrong package

Many newcomers see a monorepo and start reading the lowest-level package first.

That is usually the slow path here. Start with `packages/coding-agent` unless your task is obviously about providers, terminal rendering, Slack integration, web UI, or GPU infrastructure.

## 2. Running `npm run check` before `npm run build`

The root `README.md` explicitly warns that checks depend on built artifacts.

Use:

```bash
npm install
npm run build
npm run check
```

## 3. Skipping `./test.sh`

`CONTRIBUTING.md` requires both:

- `npm run check`
- `./test.sh`

Running only one of them is not enough.

## 4. Missing repo-specific rules in `AGENTS.md`

Even experienced contributors can get tripped up by local project rules. Read `AGENTS.md` early, especially if you are using an AI agent or following instructions copied from another repo.

## 5. Treating all packages as equally central

They are not.

For beginner onboarding, the practical order is:

1. `coding-agent`
2. `agent`
3. `ai`
4. `tui`
5. specialized packages only when needed

## 6. Confusing product entry with implementation layers

`tui` is important, but it is not the first concept most newcomers need.

Likewise, `ai` is foundational, but starting there makes the learning curve steeper than it needs to be.

## 7. Guessing config and auth precedence

The coding agent has explicit precedence rules documented in its docs.

Two especially important ones:

- credentials resolve in a defined order, with CLI `--api-key` first and environment variables later,
- project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`.

When behavior looks surprising, check `packages/coding-agent/docs/providers.md` and `packages/coding-agent/docs/settings.md` before assuming there is a bug.

## 8. Trying to understand the whole monorepo before making a first change

You do not need full-repo mastery to start contributing.

For a first task, you usually only need:

- the root rules,
- the owning package README,
- the immediate layer below it,
- and the required validation commands.

That narrower mental model is usually enough.
