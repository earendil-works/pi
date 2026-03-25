# Quick Start

This repo is a monorepo for AI agents and LLM deployment tools, but most beginners should start with the coding agent rather than the lower-level packages.

## Prerequisites

- Node.js `>=20.0.0` at the repo level
- npm

The workspace definition lives in the root `package.json` and uses npm workspaces across `packages/*`.

## Clone and install

```bash
git clone https://github.com/badlogic/pi-mono
cd pi-mono
npm install
```

## Build before running checks

The root `README.md` explicitly notes that `npm run check` depends on built artifacts, especially because `packages/web-ui` needs generated `.d.ts` files from dependencies.

```bash
npm run build
```

## Run the coding agent from source

The repo provides a source-run entry point from the repo root:

```bash
./pi-test.sh
```

That is the fastest way to experience the main product while still working inside the monorepo.

## If you want to use an installed version instead

The main package is `@mariozechner/pi-coding-agent`:

```bash
npm install -g @mariozechner/pi-coding-agent
pi
```

Authentication options from `packages/coding-agent/README.md`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

Or start `pi` and use:

```text
/login
```

## What to read next

If your goal is to get productive quickly:

1. `packages/coding-agent/README.md`
2. `packages/coding-agent/docs/providers.md`
3. `packages/coding-agent/docs/settings.md`
4. `packages/coding-agent/docs/development.md`

Then read [Repo Rules and Checks](./repo-rules-and-checks.md) before making changes.
