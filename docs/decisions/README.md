# Decision Log

## ADRs

| # | Title |
|---|---|
| 001 | [Monorepo with npm workspaces and lockstep versioning](adr/001-monorepo-with-npm-workspaces.md) |
| 002 | [Custom TUI engine with differential rendering](adr/002-custom-tui-engine-with-differential-rendering.md) — *replaced by 011* |
| 003 | [Unified AI provider abstraction with streaming-first API](adr/003-unified-ai-provider-abstraction.md) |
| 004 | [Auto-generated model registry with type-safe factory](adr/004-auto-generated-model-registry.md) |
| 005 | [Cross-provider message handoff protocol](adr/005-cross-provider-message-handoff.md) |
| 006 | [AsyncIterable streaming generate API](adr/006-asynciterable-streaming-api.md) |
| 007 | [TypeBox over Zod for schema validation](adr/007-typebox-over-zod-for-schema-validation.md) |
| 008 | [Agent architecture refactor with session persistence](adr/008-agent-architecture-refactor-and-session-persistence.md) |
| 009 | [Pluggable storage architecture and Anthropic prompt caching](adr/009-pluggable-storage-and-anthropic-prompt-caching.md) |
| 010 | [Runtime bridge for sandboxed execution](adr/010-runtime-bridge-for-sandboxed-execution.md) |
| 011 | [TUI rewrite with three-strategy differential rendering](adr/011-tui-rewrite-with-three-strategy-differential-rendering.md) |
| 012 | [Hierarchical context file loading for monorepos](adr/012-hierarchical-context-file-loading.md) |
| 013 | [Custom providers via models.json](adr/013-custom-providers-via-models-json.md) |
| 014 | [Context compaction system](adr/014-context-compaction-system.md) |
| 015 | [Bash mode for shell command execution](adr/015-bash-mode-for-shell-execution.md) |
| 016 | [Coding agent refactor into AgentSession architecture](adr/016-agent-session-architecture-refactor.md) |
| 017 | [RPC mode with typed protocol](adr/017-rpc-mode-with-typed-protocol.md) |
| 018 | [Hooks system for extensibility](adr/018-hooks-system.md) |
| 019 | [Standalone binary distribution with Bun](adr/019-standalone-binary-distribution.md) |
| 020 | [OAuth authentication for Claude Pro/Max](adr/020-oauth-authentication.md) |
| 021 | [Theming system with user-defined themes](adr/021-theming-system.md) |
| 022 | [Mistral AI provider with extended compat flags](adr/022-mistral-provider-with-compat-flags.md) |
| 023 | [Session tree structure with id/parentId branching](adr/023-session-tree-structure.md) |
| 024 | [SDK for programmatic AgentSession usage](adr/024-sdk-for-programmatic-usage.md) |
| 025 | [Unified extensions system](adr/025-unified-extensions-system.md) |
| 026 | [Configurable keybinding system](adr/026-configurable-keybindings.md) |
| 027 | [Steer and followUp API split](adr/027-steer-and-followup-api.md) |
| 028 | [Shell commands without context contribution](adr/028-shell-commands-without-context.md) |
| 029 | [Settings command with unified settings UI](adr/029-settings-command.md) |
| 030 | [Hook API expansion — plan mode, widgets, context events](adr/030-hook-api-expansion.md) |
| 031 | [Event bus for extension communication](adr/031-event-bus-for-extensions.md) |
| 032 | [OpenAI Codex OAuth provider](adr/032-openai-codex-provider.md) |
| 033 | [Extension package management with ResourceLoader](adr/033-extension-package-management.md) |
| 034 | [Amazon Bedrock provider](adr/034-amazon-bedrock-provider.md) |
| 035 | [Azure OpenAI Responses provider](adr/035-azure-openai-responses-provider.md) |
| 036 | [Rename /branch to /fork](adr/036-rename-branch-to-fork.md) |
| 037 | [Per-tool execution mode override](adr/037-per-tool-execution-mode.md) |
| 038 | [TUI overlay compositing](adr/038-tui-overlay-compositing.md) |
| 039 | [Custom provider support via extensions](adr/039-custom-provider-extension-api.md) |
| 040 | [HTTP proxy support via environment variables](adr/040-http-proxy-support.md) |

## TDRs

| ID | Title |
|---|---|
| TDR-001 | [Tool call streaming reports argument deltas, not partial JSON](tdr/TDR-001-tool-call-streaming-deltas.md) |
| TDR-002 | [GPT-5 reasoning mode cannot be fully disabled](tdr/TDR-002-gpt5-no-reasoning-off-switch.md) |
| TDR-003 | [Image resizing heuristics for provider size limits](tdr/TDR-003-image-resizing-heuristics.md) |
| TDR-004 | [Session tree migration without rollback](tdr/TDR-004-session-tree-migration-risks.md) |
| TDR-005 | [Truecolor assumed for all terminals](tdr/TDR-005-truecolor-assumption.md) |
| TDR-006 | [Image processing library churn](tdr/TDR-006-image-processing-churn.md) |
