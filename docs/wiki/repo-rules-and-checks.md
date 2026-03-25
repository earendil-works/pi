# Repo Rules and Checks

This page exists because the fastest way for a beginner to get stuck in this repo is to miss a rule that maintainers consider basic.

## The contribution gate

`CONTRIBUTING.md` makes the standard explicit:

- You must understand your changes.
- If you use an AI agent, you are still expected to understand edge cases and system interactions.
- First-time contributors should open an issue first and wait for maintainer approval.

The practical takeaway is simple: do not treat this repo as “generate code and hope CI passes.”

## Required checks before submitting work

From `CONTRIBUTING.md`:

```bash
npm run check
./test.sh
```

Important context from the root `README.md`:

- `npm run check` requires `npm run build` to have been run first.

So the safe sequence is:

```bash
npm install
npm run build
npm run check
./test.sh
```

## Repo-specific rules in `AGENTS.md`

`AGENTS.md` is not just for automated agents. It documents repo-specific expectations that matter to human contributors too.

The most important beginner-facing points are:

- If you are using an AI agent, run it from the repo root so it picks up `AGENTS.md` automatically.
- After code changes, the required validation command is `npm run check`.
- Some commands are intentionally discouraged or constrained in this repo’s development process.
- Package-specific READMEs are the expected starting point when working in a module.

## Root scripts worth knowing

From the root `package.json`:

- `npm run build` — builds packages in dependency order
- `npm run check` — runs formatting, linting, type checks, a browser smoke check, and `packages/web-ui` checks
- `./test.sh` — test harness used by contributors
- `./pi-test.sh` — run pi from source

## Recommended reading before your first change

1. `README.md`
2. `CONTRIBUTING.md`
3. `AGENTS.md`
4. `packages/coding-agent/README.md`

Then continue with [Architecture Overview](./architecture.md).
