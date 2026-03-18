# core — Coding Agent Engine

Heart of pi. Tool execution, extension lifecycle, sessions, model resolution, prompts.

## Key Modules
| File | Role |
|------|------|
| `sdk.ts` | Public SDK for extensions — creates agent sessions with configured tools |
| `system-prompt.ts` | Builds the system prompt (tool instructions, context, CLAUDE.md) |
| `model-resolver.ts` | Resolves `provider/model:level` patterns, DEFAULT_MODELS map |
| `model-registry.ts` | Custom model registry from models.json |
| `session-manager.ts` | Session persistence, branching, tree navigation |
| `agent-session.ts` | Wires agent + tools + extensions into a running session |
| `bash-executor.ts` | Sandboxed bash execution with spawn hooks |
| `settings-manager.ts` | User settings (default model, provider, thinking level) |
| `skills.ts` | Skill discovery and loading from SKILL.md files |
| `resource-loader.ts` | Loads CLAUDE.md / AGENTS.md from project + user dirs |
| `event-bus.ts` | Internal pub/sub for cross-component communication |
| `keybindings.ts` | Configurable keyboard shortcuts |

## Subdirectories
- `tools/` — Built-in tools: bash, read, edit, write, grep, find, ls (+ truncation, diff, path utils)
- `extensions/` — Extension loader, types (full event system), SDK
- `compaction/` — Context window management, message compaction
- `export-html/` — Session export to HTML

## Conventions
- Tools follow the pattern in `tools/bash.ts`: schema → create function → export singleton (factory for custom cwd, singleton for default)
- Extension events: see `extensions/types.ts` for full event list (40+ events)
- Model pattern: `provider/model-id:thinking-level` (parsed by `model-resolver.ts`)
- Session files are append-only NDJSON (event-sourced). Never mutate entries — always append.
- System prompt is rebuilt on every `prompt()` call, not once at session start
- Extensions loaded via jiti with `virtualModules` (for compiled Bun binary compatibility)
- Extension init is two-phase: Phase 1 (registration only), Phase 2 (`bindCore()` — live actions)
- `extensionRunnerRef` is a mutable ref so `/reload` swaps the runner without recreating the Agent
- `getApiKey` reads provider from in-flight request, not `agent.state.model` (handles mid-turn model switches)
- Resource loader walks from cwd to filesystem root collecting AGENTS.md/CLAUDE.md at every level
