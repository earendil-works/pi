# pi-mono Wiki

This wiki is the fastest path to understanding the repository without reading the entire monorepo front to back.

The short version is:

- `packages/coding-agent` is the main user-facing product and the best entry point.
- `packages/agent` and `packages/ai` are the core runtime layers underneath it.
- `packages/tui` is the terminal UI layer used by the coding agent.
- `packages/web-ui`, `packages/mom`, and `packages/pods` are specialized packages you only need once you know which surface you care about.

## Start here

If you are new, read these pages in order:

1. [Quick Start](./quick-start.md)
2. [Repo Rules and Checks](./repo-rules-and-checks.md)
3. [Architecture Overview](./architecture.md)
4. [Code Reading Map](./code-reading-map.md)
5. [Development Workflow](./development-workflow.md)
6. [Package Guide](./package-guide.md)
7. [Common Pitfalls](./common-pitfalls.md)

## Two common newcomer paths

### I want to use pi first

Start with:

- [Quick Start](./quick-start.md)
- [Code Reading Map](./code-reading-map.md)
- `packages/coding-agent/README.md`
- `packages/coding-agent/docs/providers.md`
- `packages/coding-agent/docs/settings.md`

### I want to contribute code

Start with:

- [Repo Rules and Checks](./repo-rules-and-checks.md)
- [Development Workflow](./development-workflow.md)
- [Architecture Overview](./architecture.md)
- [Code Reading Map](./code-reading-map.md)
- [Package Guide](./package-guide.md)

## Primary source documents

This wiki is based on the repo’s own entry points and contributor rules:

- Root overview: `README.md`
- Contribution gate: `CONTRIBUTING.md`
- Repo-specific rules: `AGENTS.md`
- Workspace and scripts: `package.json`
- Main product docs: `packages/coding-agent/README.md`

Use this wiki for orientation. Use those files as the source of truth when you need exact behavior.
