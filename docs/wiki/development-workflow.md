# Development Workflow

This page describes the workflow that makes sense once you already know the repo rules.

If you have not read them yet, read [Repo Rules and Checks](./repo-rules-and-checks.md) first.

## 1. Start at the repo root

This repo is organized as npm workspaces, so the root is the right place to install dependencies, build packages, and run shared checks.

```bash
npm install
```

## 2. Build before validating

The root `README.md` explicitly says `npm run check` requires a prior build.

```bash
npm run build
```

## 3. Run the required validation commands

Before submitting code, `CONTRIBUTING.md` requires:

```bash
npm run check
./test.sh
```

## 4. Use module READMEs to narrow scope

This monorepo is broad enough that “just search around” is a slow path. A better pattern is:

1. Identify the package you are working in.
2. Read that package’s README first.
3. Then read the specific docs under that package, if they exist.

For example, in `packages/coding-agent`, the most useful supporting docs for beginners are:

- `packages/coding-agent/docs/development.md`
- `packages/coding-agent/docs/providers.md`
- `packages/coding-agent/docs/settings.md`

## 5. Run the main product from source when needed

If you want to verify behavior in the main CLI from inside the monorepo, use the root helper script:

```bash
./pi-test.sh
```

## 6. Know when to branch into specialized packages

After the core stack, choose your package by problem type:

- CLI behavior or session/resource loading → `packages/coding-agent`
- Agent loop or tool lifecycle → `packages/agent`
- Provider/model/auth behavior → `packages/ai`
- Terminal rendering or input handling → `packages/tui`
- Browser UI → `packages/web-ui`
- Slack automation → `packages/mom`
- Remote model deployment → `packages/pods`

## 7. Keep the contributor mindset simple

For a first change, your goal is not to understand the entire monorepo. Your goal is to understand:

- which package owns the behavior,
- which README explains the intended usage,
- which root checks are mandatory,
- and which lower layer the package depends on.

That is enough context to start productively.
