# Decision Log

## ADRs

| # | Title |
|---|---|
| 001 | [Monorepo with npm Workspaces and Lockstep Versioning](adr/001-monorepo-with-npm-workspaces.md) |
| 002 | [Custom TUI Engine with Differential Rendering](adr/002-custom-tui-engine-with-differential-rendering.md) — *replaced by 011* |
| 003 | [Unified AI Provider Abstraction with Streaming-First API](adr/003-unified-ai-provider-abstraction.md) |
| 004 | [Auto-Generated Model Registry with Type-Safe Factory](adr/004-auto-generated-model-registry.md) |
| 005 | [Cross-Provider Message Handoff Protocol](adr/005-cross-provider-message-handoff.md) |
| 006 | [AsyncIterable Streaming Generate API](adr/006-asynciterable-streaming-api.md) |
| 007 | [TypeBox Over Zod for Schema Validation](adr/007-typebox-over-zod-for-schema-validation.md) |
| 008 | [Pluggable Storage Architecture and Anthropic Prompt Caching](adr/008-pluggable-storage-and-anthropic-prompt-caching.md) |
| 009 | [Agent Architecture Refactor with Session Persistence](adr/009-agent-architecture-refactor-and-session-persistence.md) |
| 010 | [Runtime Bridge for Sandboxed Provider Execution](adr/010-runtime-bridge-for-sandboxed-execution.md) |
| 011 | [TUI Rewrite with Three-Strategy Differential Rendering](adr/011-tui-rewrite-with-three-strategy-differential-rendering.md) |
| 012 | [Hierarchical Context File Loading for Monorepos](adr/012-hierarchical-context-file-loading.md) |
| 013 | [Custom Providers via models.json](adr/013-custom-providers-via-models-json.md) |
| 014 | [OAuth Authentication for Claude Pro/Max](adr/014-oauth-authentication.md) |
| 015 | [Theming System with User-Defined Themes](adr/015-theming-system.md) |
| 016 | [Standalone Binary Distribution with Bun](adr/016-standalone-binary-distribution.md) |
| 017 | [Context Compaction System](adr/017-context-compaction-system.md) |
| 018 | [Bash Mode for Shell Command Execution](adr/018-bash-mode-for-shell-execution.md) |
| 019 | [Coding Agent Refactor into AgentSession Architecture](adr/019-agent-session-architecture-refactor.md) |
| 020 | [RPC Mode with Typed Protocol](adr/020-rpc-mode-with-typed-protocol.md) |
| 021 | [Hooks System for Extensibility](adr/021-hooks-system.md) |
| 022 | [Mistral AI Provider with Extended Compat Flags](adr/022-mistral-provider-with-compat-flags.md) |
| 023 | [SDK for Programmatic AgentSession Usage](adr/023-sdk-for-programmatic-usage.md) |
| 024 | [Session Tree Structure with id/parentId Branching](adr/024-session-tree-structure.md) |
| 025 | [Settings Command with Unified Settings UI](adr/025-settings-command.md) |
| 026 | [Unified Extensions System](adr/026-unified-extensions-system.md) |
| 027 | [Configurable Keybinding System](adr/027-configurable-keybindings.md) |
| 028 | [Shell Commands Without Context Contribution](adr/028-shell-commands-without-context.md) |
| 029 | [Steer and FollowUp API Split](adr/029-steer-and-followup-api.md) |
| 030 | [Hook API Expansion — Plan Mode, Widgets, Context Events](adr/030-hook-api-expansion.md) |
| 031 | [OpenAI Codex OAuth Provider](adr/031-openai-codex-provider.md) |
| 032 | [Rename /branch to /fork](adr/032-rename-branch-to-fork.md) |
| 033 | [Event Bus for Extension Communication](adr/033-event-bus-for-extensions.md) |
| 034 | [TUI Overlay Compositing](adr/034-tui-overlay-compositing.md) |
| 035 | [Amazon Bedrock Provider](adr/035-amazon-bedrock-provider.md) |
| 036 | [HTTP Proxy Support via Environment Variables](adr/036-http-proxy-support.md) |
| 037 | [Custom Provider Support via Extensions](adr/037-custom-provider-extension-api.md) |
| 038 | [Extension Package Management with ResourceLoader](adr/038-extension-package-management.md) |
| 039 | [Azure OpenAI Responses Provider](adr/039-azure-openai-responses-provider.md) |
| 040 | [Per-Tool Execution Mode Override](adr/040-per-tool-execution-mode.md) |
| 041 | [AgentHarness Testing Architecture](adr/041-agent-harness.md) |
| 042 | [Provider and Package Pruning](adr/042-provider-and-package-pruning.md) |
| 043 | [Image Output Generation](adr/043-image-output-generation.md) |
| 044 | [Constrained Sampling for Structured Output](adr/044-constrained-sampling.md) |
| 045 | [Models Runtime with Provider-Owned Auth](adr/045-models-runtime.md) |
| 046 | [Per-Request Fetch Injection](adr/046-per-request-fetch-injection.md) |
| 047 | [SQLite Session Storage Backend](adr/047-sqlite-session-storage.md) |

## TDRs

| ID | Title |
|---|---|
| TDR-001 | [Tool call streaming reports argument deltas, not partial JSON](tdr/TDR-001-tool-call-streaming-deltas.md) |
| TDR-002 | [GPT-5 reasoning mode cannot be fully disabled](tdr/TDR-002-gpt5-no-reasoning-off-switch.md) |
| TDR-003 | [Image resizing heuristics for provider size limits](tdr/TDR-003-image-resizing-heuristics.md) |
| TDR-004 | [Session tree migration without rollback](tdr/TDR-004-session-tree-migration-risks.md) |
| TDR-005 | [Truecolor assumed for all terminals](tdr/TDR-005-truecolor-assumption.md) |
| TDR-006 | [Image processing library churn](tdr/TDR-006-image-processing-churn.md) |
