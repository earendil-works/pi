# Pi Monorepo - Project Context

## Project Overview
The **Pi Monorepo** is a comprehensive collection of tools for building AI agents and managing Large Language Model (LLM) deployments. It is a TypeScript monorepo using **npm workspaces**, designed for high-performance interactive AI applications.

### Key Packages
- **`@mariozechner/pi-ai`** (`packages/ai`): Unified multi-provider LLM API supporting OpenAI, Anthropic, Google, etc.
- **`@mariozechner/pi-agent-core`** (`packages/agent`): Core agent runtime with tool calling and state management.
- **`@mariozechner/pi-coding-agent`** (`packages/coding-agent`): The primary interactive coding agent CLI.
- **`@mariozechner/pi-mom`** (`packages/mom`): Slack bot integration for the coding agent.
- **`@mariozechner/pi-tui`** (`packages/tui`): Terminal UI library with differential rendering for rich CLI experiences.
- **`@mariozechner/pi-web-ui`** (`packages/web-ui`): Web components for AI chat interfaces.
- **`@mariozechner/pi-pods`** (`packages/pods`): CLI tool for managing vLLM deployments on GPU pods.
- **`spec-kit`**: A toolkit for Spec-Driven Development (SDD) that uses specifications to generate implementations.

---

## Building and Running

### Setup
```bash
npm install          # Install all dependencies
npm run build        # Build all packages (requires specific order)
```

### Development & Verification
- **`npm run check`**: Runs Biome for linting/formatting and `tsgo` for type checking. **Requires `npm run build` first.**
- **`./test.sh`**: Runs tests across the entire monorepo (skips LLM-dependent tests if API keys are missing).
- **`./pi-test.sh`**: Runs the `pi` coding agent directly from source.
- **Package-specific dev**: Each package in `packages/` supports `npm run dev` for watch mode.

---

## Development Conventions

### Code Quality & Patterns
- **No `any` types**: Strict typing is required.
- **Standard Imports**: Use top-level imports only. **NEVER use inline/dynamic imports** (`await import(...)`) or dynamic type imports.
- **Keybindings**: Never hardcode key checks. All keybindings must be configurable via default binding objects (e.g., `DEFAULT_EDITOR_KEYBINDINGS`).
- **Dependencies**: Upgrade dependencies to fix type errors instead of downgrading code.

### Git & Collaboration (Critical for Agents)
- **Surgical Commits**: Only stage and commit files you specifically changed.
- **Parallel Work Safety**: Multiple agents may work in the same worktree. **NEVER** use:
  - `git add .` or `git add -A` (use `git add <file>` instead)
  - `git reset --hard`, `git checkout .`, `git clean -fd`, or `git stash`
- **Issue Closing**: Include `fixes #<number>` in commit messages to auto-close GitHub issues.

### Maintenance
- **Changelogs**: Each package has its own `CHANGELOG.md`. New entries go under `## [Unreleased]` in the relevant subsection (`Added`, `Fixed`, `Changed`, `Removed`, `Breaking Changes`).
- **Lockstep Versioning**: All packages share the same version number. Use `npm run release:patch` or `npm run release:minor` for releases.
- **OSS Weekend**: The project has an "OSS Weekend" mode (Thursday to Monday) where issues/PRs from unapproved contributors are auto-closed. Use `node scripts/oss-weekend.mjs` to manage this.

---

## Instructional Context for AI Agents
- **First Action**: If no concrete task is given, read the root `README.md` and ask which package(s) to work on.
- **Verification**: After code changes, run `npm run check` and fix ALL errors/warnings before considering the task done.
- **Testing**: Run tests from the package root, not the repo root. Use `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts` for targeted test runs.
- **Communication**: Keep comments and responses short, technical, and concise. No emojis or cheerful filler text.
