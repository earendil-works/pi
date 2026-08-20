# Requirements

This document describes the functional and non-functional requirements implied by the current capabilities of the `secure-pi-mono` codebase. It is derived from the existing implementation and package documentation, not a forward-looking spec — it exists to give a single reference point for what the system currently does and must continue to do.

## 1. Scope

`secure-pi-mono` is a closed-network security fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono): an npm workspaces monorepo providing a unified multi-provider LLM API, an agent runtime, a terminal coding agent CLI, a terminal UI toolkit, a Slack bot, a web chat UI toolkit, and a GPU pod manager. All packages share a single lockstep version number.

## 2. Security Fork Requirements (cross-cutting)

These requirements apply across `packages/ai` and `packages/coding-agent` and take precedence over general provider requirements below.

- **R2.1** `secureMode` MUST be enabled by default. Any provider without an explicit `baseUrl` configured in `models.json` MUST be hidden from the model list and blocked from registration.
- **R2.2** Enforcement MUST occur at all of: `ModelRegistry.getAvailable()` (model picker/cycling), `ModelRegistry.registerProvider()` (extension-registered providers, also reached via `runner.ts bindCore()` at bind time — `bindCore()` delegates rather than enforcing independently), and `resolveCliModel()` (CLI `--model` selection).
- **R2.3** The application MUST start with an empty model list until the user configures at least one provider in `~/.spi/agent/models.json` (or `~/.pi/agent/models.json`).
- **R2.4** Outbound non-LLM network calls MUST be permanently disabled regardless of environment variables: npm version checks, package update checks, `/share` (GitHub gist upload), and Google OAuth (`/login google-*`).
- **R2.5** Disabled code paths MUST be gated, not deleted, to preserve upstream diff compatibility with `badlogic/pi-mono`.
- **R2.6** Protocol implementations (OpenAI-compat, Anthropic-compat, Google-compat, etc.) MUST remain fully functional so self-hosted/internal models can use them without code changes.
- **R2.7** Built-in commercial providers MUST become available again if the user supplies an explicit `baseUrl` for them (e.g., routing Anthropic through an internal gateway) — this preserves the full model list while changing only the endpoint.
- **R2.8** `apiKey` fields in `models.json` MUST support three resolution modes: environment variable name, shell command (`"!command"`, stdout used as the key), and literal value.

## 3. `@tculpepp/spi-ai` — LLM Provider Library

- **R3.1** MUST provide a unified streaming (`stream`/`streamSimple`) and non-streaming (`complete`/`completeSimple`) API across 20+ providers (OpenAI, Azure OpenAI, OpenAI Codex, Anthropic, Google, Vertex AI, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, MiniMax, GitHub Copilot, Google Gemini CLI, Antigravity, Amazon Bedrock, OpenCode Zen/Go, Kimi For Coding, and any OpenAI-compatible endpoint).
- **R3.2** MUST only include models that support tool calling.
- **R3.3** MUST emit standardized streaming events (`start`, `text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end`, `done`, `error`) uniformly across providers.
- **R3.4** MUST support TypeBox-based tool schema definitions with AJV validation (`validateToolCall`), serializable as plain JSON.
- **R3.5** MUST support image input for vision-capable models, silently ignoring images for non-vision models.
- **R3.6** MUST support thinking/reasoning both via a unified interface (`reasoning: 'minimal'|'low'|'medium'|'high'|'xhigh'`) and provider-specific options (Anthropic `thinkingEnabled`/`thinkingBudgetTokens`, OpenAI `reasoningEffort`, Google `thinking.budgetTokens`).
- **R3.7** MUST report a `stopReason` (`stop`, `length`, `toolUse`, `error`, `aborted`) on every `AssistantMessage`, and support request cancellation via `AbortSignal` with resumable partial-content continuation.
- **R3.8** MUST support cross-provider handoff mid-conversation, transforming thinking blocks to tagged text when switching providers while preserving tool calls, tool results, and plain text.
- **R3.9** `Context` objects MUST be JSON-serializable for persistence and transfer between services/models.
- **R3.10** MUST run in both Node.js (env-var API key resolution) and browser environments (explicit API key required; Bedrock and OAuth flows unsupported in-browser).
- **R3.11** MUST support OAuth login/token-refresh flows for Anthropic, OpenAI Codex, GitHub Copilot, Google Gemini CLI, and Antigravity, with credential storage left to the caller.
- **R3.12** MUST provide a faux/in-memory provider (`registerFauxProvider`) for deterministic testing without real API calls.
- **R3.13** MUST support custom/self-hosted model definitions (arbitrary `baseUrl`, `compat` flags) for local inference servers (Ollama, vLLM, LM Studio, etc.).
- **R3.14** Adding a new provider MUST touch: `src/types.ts`, `src/providers/<provider>.ts`, `package.json` subpath exports, `src/providers/register-builtins.ts` (lazy-loaded, no static imports), `src/env-api-keys.ts`, `scripts/generate-models.ts`, the standard provider test suite, and `packages/coding-agent/src/core/model-resolver.ts`.

## 4. `@tculpepp/spi-agent-core` — Agent Runtime

- **R4.1** MUST provide a stateful `Agent` class managing conversation state (`systemPrompt`, `model`, `thinkingLevel`, `tools`, `messages`) with an event-subscription model.
- **R4.2** MUST support a distinct `AgentMessage` type (superset of LLM messages, extensible via declaration merging) separate from the LLM-facing `Message` type, bridged via a required `convertToLlm` transform and an optional `transformContext` hook.
- **R4.3** MUST emit a well-defined event sequence per turn (`agent_start`, `turn_start`, `message_start/update/end`, `tool_execution_start/update/end`, `turn_end`, `agent_end`), with `agent_end` acting as a barrier for awaited subscribers.
- **R4.4** MUST support both `parallel` (default) and `sequential` tool execution modes, plus `beforeToolCall` (blocking preflight) and `afterToolCall` (postprocessing) hooks.
- **R4.5** MUST support steering (interrupt mid-turn) and follow-up (queue after completion) messages, each independently configurable as `one-at-a-time` or `all`.
- **R4.6** MUST support `continue()` to resume from existing context (last message must be `user` or `toolResult`), and `abort()`/`waitForIdle()` for control flow.
- **R4.7** Tool `execute` functions MUST throw on failure (not return error content); thrown errors MUST be surfaced to the LLM as `isError: true` tool results.
- **R4.8** MUST support a low-level `agentLoop`/`agentLoopContinue` API for callers that don't need the `Agent` class's barrier semantics.
- **R4.9** MUST support pluggable `streamFn` for proxying through a backend (browser use cases) and dynamic `getApiKey` resolution for expiring OAuth tokens.

## 5. `@tculpepp/spi-coding-agent` — Terminal Coding Agent CLI

- **R5.1** MUST run in four modes: interactive (TUI), print/JSON (non-interactive), RPC (stdin/stdout JSONL for process integration), and SDK (embedded).
- **R5.2** MUST provide four built-in tools by default (`read`, `write`, `edit`, `bash`), with optional `grep`, `find`, `ls`, individually selectable via `--tools`/`--no-tools`.
- **R5.3** MUST support session persistence as tree-structured JSONL (`id`/`parentId`), enabling in-place branching (`/tree`), forking (`/fork`, `--fork`), resume (`-r`), and continue (`-c`) without duplicating history files.
- **R5.4** MUST support both manual (`/compact`) and automatic context compaction (on overflow or approaching the limit), remaining lossy in the live context while preserving full history in the session file.
- **R5.5** MUST load context files (`AGENTS.md`/`CLAUDE.md`) from global, parent-directory, and project locations, concatenating all matches; MUST support system prompt override/append via `SYSTEM.md`/`APPEND_SYSTEM.md`.
- **R5.6** MUST support four extensibility mechanisms, each loadable from global, project, or package locations: prompt templates (`/name`), skills (`/skill:name`, Agent Skills standard), TypeScript extensions (custom tools/commands/keybindings/UI), and themes (hot-reloading).
- **R5.7** MUST support package installation from npm, git, and direct URL/SSH sources (`spi install/remove/list/update/config`), with pinned-version awareness on update.
- **R5.8** RPC mode MUST use strict LF-only JSONL framing (not generic line-splitting, which breaks on Unicode separators inside JSON payloads).
- **R5.9** All keybindings MUST be user-configurable via `~/.spi/agent/keybindings.json` — no hardcoded key checks.
- **R5.10** MUST NOT implement MCP support, sub-agents, plan mode, built-in to-dos, or background bash in core — these are explicitly left to extensions/packages by design.
- **R5.11** See [Security Fork Requirements](#2-security-fork-requirements-cross-cutting) for closed-network-specific behavior layered on top of upstream `pi` functionality.

## 6. `@tculpepp/spi-tui` — Terminal UI Toolkit

- **R6.1** MUST render via differential updates (three strategies: first render, full re-render on width change, incremental update) wrapped in synchronized output (CSI 2026) to avoid flicker.
- **R6.2** Every `Component.render(width)` MUST return lines that do not exceed `width`; the TUI MUST error if this is violated.
- **R6.3** MUST support overlays (dialogs/menus) with configurable sizing, anchor/percentage/absolute positioning, margins, responsive visibility, and focus management independent of the base component tree.
- **R6.4** MUST support IME candidate-window positioning via the `Focusable` interface and `CURSOR_MARKER`; container components embedding `Input`/`Editor` MUST propagate `focused` state to children.
- **R6.5** MUST ship built-in components: `Text`, `TruncatedText`, `Input`, `Editor`, `Markdown`, `Loader`, `CancellableLoader`, `SelectList`, `SettingsList`, `Spacer`, `Image`, `Box`, `Container`.
- **R6.6** MUST render inline images via Kitty/iTerm2 graphics protocols where supported, falling back to a text placeholder otherwise (PNG, JPEG, GIF, WebP).
- **R6.7** MUST provide ANSI-aware string utilities (`visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`) that correctly handle escape codes without corrupting styling across truncation/wrapping.
- **R6.8** MUST abstract the terminal via a `Terminal` interface, with both a real (`ProcessTerminal`) and a headless/testable (`VirtualTerminal`) implementation.

## 7. `@tculpepp/spi-mom` — Slack Bot

- **R7.1** MUST connect to Slack via Socket Mode and respond to `@mentions` and DMs only in channels it has been explicitly added to.
- **R7.2** MUST maintain a separate, isolated conversation history, memory, and file workspace per channel, rooted under a single user-controlled data directory.
- **R7.3** MUST persist raw channel history append-only in `log.jsonl` (source of truth) and sync an LLM-facing, compactable `context.jsonl` from it before each response.
- **R7.4** MUST support tool execution in one of two sandbox modes: Docker (isolated container, recommended) or host (full machine access, not recommended) — selected via `--sandbox`.
- **R7.5** MUST be self-managing: able to install its own OS/CLI tooling, write and register new skills (CLI tools with a `SKILL.md` under `skills/`), and persist anything it installs within its sandbox across sessions.
- **R7.6** MUST support three scheduled-wakeup event types written as JSON files to `data/events/`: immediate, one-shot (auto-deleted after firing), and periodic (cron-based, persists until deleted), with a per-channel queue cap of 5.
- **R7.7** MUST expose `bash`, `read`, `write`, `edit`, and `attach` as its baseline toolset.
- **R7.8** MUST read global and per-channel `MEMORY.md` files before responding, and support explicit updates to them.
- **R7.9** Given mom's exposure to direct and indirect prompt-injection-driven credential exfiltration, deployments MUST scope credentials tightly (dedicated/read-only bot accounts, no production credentials) and MUST prefer Docker sandbox isolation; separate mom instances MUST be used per trust boundary (public vs. private/sensitive channels).

## 8. `@tculpepp/spi` (pods) — GPU Pod Manager

- **R8.1** MUST automate vLLM setup on fresh Ubuntu GPU pods and expose an OpenAI-compatible API endpoint per running model.
- **R8.2** MUST support DataCrunch (shared NFS storage across pods) and RunPod (persistent network volumes) as primary providers, with best-effort support for any SSH-reachable Ubuntu host with NVIDIA GPUs.
- **R8.3** MUST provide predefined, validated configurations (tool-call parser, GPU/VRAM fit-checking) for known agentic model families (Qwen, GPT-OSS, GLM), while allowing arbitrary `--vllm` passthrough args for unlisted models.
- **R8.4** MUST support multi-model, multi-GPU deployment per pod with automatic GPU assignment and configurable memory (`--memory`) and context window (`--context`) allocation.
- **R8.5** MUST provide an interactive/scriptable agent CLI (`pi agent`, standalone `pi-agent`) with file-system tools (read/list/bash/glob/rg), session persistence per project directory, and JSONL event-stream output for programmatic use.
- **R8.6** `--memory`, `--context`, and `--gpus` MUST be ignored (with a warning) when `--vllm` custom args are supplied, to avoid conflicting configuration.

## 9. `@tculpepp/spi-web-ui` — Web Chat UI Components

- **R9.1** MUST provide a complete, embeddable chat interface (`ChatPanel`/`AgentInterface`) built on `@tculpepp/spi-agent-core`, including message history, streaming, and tool execution UI.
- **R9.2** MUST support file attachments (PDF, DOCX, XLSX, PPTX, images) with preview and text extraction, and sandboxed interactive artifacts (HTML, SVG, Markdown, JSON, images).
- **R9.3** MUST persist settings, provider API keys, sessions, and custom provider definitions via an IndexedDB-backed storage abstraction (`AppStorage`), swappable via `StorageBackend`.
- **R9.4** MUST support custom/local providers (Ollama, LM Studio, vLLM, arbitrary OpenAI-compatible) configured at runtime, not just build time.
- **R9.5** MUST handle browser CORS restrictions via an opt-in, per-provider proxy configuration (always required for zai; required for Anthropic only with OAuth tokens).
- **R9.6** MUST support extensible custom message types (declaration merging) and custom tool/message renderers without forking the library.
- **R9.7** MUST support runtime-swappable UI language via a translation registry (`i18n`/`setLanguage`).

## 10. Tooling & Development Constraints

- **R10.1** All code MUST be TypeScript 5.9, ESM, targeting ES2022 with Node16 module resolution, on Node.js ≥20.0.0.
- **R10.2** MUST use Biome for linting/formatting (tabs, 120-char lines) and `tsgo --noEmit` for type checking; `npm run check` MUST be run after every code change and MUST pass with zero errors, warnings, or infos.
- **R10.3** MUST NOT use inline/dynamic imports (`await import(...)`) — top-level `import` only, including in provider registration.
- **R10.4** MUST NOT use `any` types unless strictly necessary.
- **R10.5** Type errors from outdated dependencies MUST be resolved by upgrading the dependency, never by downgrading or suppressing.
- **R10.6** All packages MUST share one lockstep version number, bumped together via the release scripts; version semantics are non-standard (`patch` = fixes and new features, `minor` = breaking API changes, no `major` releases in practice).
- **R10.7** Changelog entries MUST be added under each affected package's `## [Unreleased]` section and MUST NOT modify already-released version sections.
- **R10.8** Tests MUST use the faux provider (`registerFauxProvider` / `test/suite/harness.ts`) rather than real provider APIs or API keys; the TUI package uses Node's native test runner, others use Vitest.
