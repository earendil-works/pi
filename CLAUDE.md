# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read `AGENTS.md` immediately** — it contains mandatory development rules that override general conventions.

## Commands

```bash
npm run check          # Lint (Biome) + type check (tsgo --noEmit) — run after every code change
npm run release:patch  # Bump patch version, finalize CHANGELOGs, tag, publish all packages
npm run release:minor  # Same but minor bump (use for breaking API changes)
npm run clean          # Remove all dist/ directories
./test.sh              # Run tests with all API keys unset
./pi-test.sh [args]    # Run pi from source (--no-env to strip all keys, -i for interactive)
```

**Never run**: `npm run dev`, `npm run build`, `npm test`

To run a specific test (from the package root, not repo root):
```bash
cd packages/ai
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

TUI package uses Node's native test runner instead of Vitest.

## Monorepo Structure

npm workspaces monorepo under `packages/`. All packages share a lockstep version number.

| Package | npm name | Purpose |
|---------|----------|---------|
| `packages/ai/` | `@tculpepp/spi-ai` | Unified LLM API — 20+ providers (OpenAI, Anthropic, Google, Mistral, Bedrock, etc.) |
| `packages/agent/` | `@tculpepp/spi-agent-core` | Stateful agent with tool execution and event streaming |
| `packages/coding-agent/` | `@tculpepp/spi-coding-agent` | CLI harness (`read`, `write`, `edit`, `bash` tools) |
| `packages/tui/` | `@tculpepp/spi-tui` | Terminal UI library with differential rendering |
| `packages/web-ui/` | `@tculpepp/spi-web-ui` | Web components for AI chat interfaces |
| `packages/mom/` | `@tculpepp/spi-mom` | Slack bot that builds its own tools |
| `packages/pods/` | `@tculpepp/spi` | GPU pod manager for vLLM deployments |

Dependency hierarchy: `pi-ai` → `pi-agent-core` → `pi-coding-agent` (+ `pi-tui`)

## Architecture

### Security Fork

This repo is a closed-network security fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono), not the upstream project. Key deltas:

- `secureMode` is on by default: any provider without an explicit `baseUrl` in `~/.spi/agent/models.json` is hidden from the model list and blocked from registration (enforced in `ModelRegistry.getAvailable()`, `ModelRegistry.registerProvider()`, and `resolveCliModel()`; `runner.ts bindCore()` delegates extension provider registration to `ModelRegistry.registerProvider()` rather than enforcing independently). Built-in commercial endpoints (Anthropic, OpenAI, Google, etc.) are invisible unless redirected through a `baseUrl`.
- No default models — app starts with an empty model list until a provider is configured in `models.json`.
- Outbound non-LLM calls (npm version check, package update check, `/share` gist upload, Google OAuth) are permanently disabled at startup regardless of env vars; original code paths are gated, not deleted, to preserve upstream diff compatibility.

See `README.md` for the full `models.json` example and `packages/coding-agent/docs/models.md` for the config reference.

### LLM Provider Pattern (`packages/ai`)

Each provider exports `stream<Provider>(options)` and `streamSimple<Provider>(SimpleStreamOptions)` returning `AssistantMessageEventStream`. Providers are registered lazily in `src/providers/register-builtins.ts` (no static imports there). Each provider emits standardized events: `text`, `tool_call`, `thinking`, `usage`, `stop`.

Adding a new provider requires changes in: `src/types.ts`, `src/providers/<provider>.ts`, `package.json` subpath exports, `src/providers/register-builtins.ts`, `src/env-api-keys.ts`, `scripts/generate-models.ts`, multiple test files, and `packages/coding-agent/src/core/model-resolver.ts`. See `AGENTS.md` for the full checklist.

### Agent Pattern (`packages/agent`)

`Agent` class holds conversation state. Call `agent.prompt(text)` to send messages. Subscribe to events via the returned stream. An optional `transformContext()` hook runs before each LLM call.

### Coding Agent (`packages/coding-agent`)

Entry: `src/cli.ts`. Modes: Interactive (TUI), Print (JSON), RPC (inter-process), SDK (embedded). Extensions, skills, prompt templates, and themes load from `~/.spi/` or the config path.

Test suite for regressions lives in `packages/coding-agent/test/suite/regressions/<issue-number>-<slug>.test.ts`. Always use the faux provider (`test/suite/harness.ts`) — never real API keys.

## Key Rules (from AGENTS.md)

- **No inline/dynamic imports** — only top-level `import` statements.
- **No `any`** unless absolutely necessary.
- **Keybindings must be configurable** — never hardcode `matchesKey(keyData, "ctrl+x")`; add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.
- **Upgrade deps to fix type errors**, never downgrade.
- **Git**: only `git add <specific-files>`, never `git add -A`. Never `git reset --hard`, `git checkout .`, or `git commit --no-verify`.
- **GitHub comments**: write to a temp file, use `gh issue comment --body-file`. Never pass multi-line markdown via `--body`.
- **PR workflow**: no PRs opened by Claude — work in feature branches, merge to main, push.
- **Changelogs**: entries always go under `## [Unreleased]` in `packages/*/CHANGELOG.md`. Never edit released version sections.
- **Version semantics (no major releases)**: `patch` = bug fixes and new features, `minor` = API breaking changes. Non-standard — check before assuming semver norms.

## Tooling

- **Language**: TypeScript 5.9 (ESM, target ES2022, Node16 modules)
- **Linter/Formatter**: Biome — tabs, 120-char lines; `noNonNullAssertion` and `noExplicitAny` disabled
- **Build**: `tsgo` per package; root `tsconfig.json` maps package names to `src/index.ts` for type checking
- **Node**: ≥20.0.0 required
