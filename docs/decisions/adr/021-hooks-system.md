# 021: Hooks System for Extensibility

**Date:** 2025-12-09
**Source:** Commit `04d59f31`

## Context

External tools and scripts needed to interact with the agent mid-conversation: inject messages, approve tool calls, feed in live context. The architecture had no extension mechanism: everything was either built-in or not possible. The refactored `AgentSession` (ADR-019) opened the door for a plugin system, but the team needed a lightweight approach that didn't require a full SDK.

## Decision

Implement a hooks system in `core/hooks/` with three components: a loader that discovers hook scripts from a configured directory, a runner that executes hooks at defined lifecycle points, and typed interfaces for hook authors. Each hook receives a `HookUIContext` that adapts to the current mode (interactive: TUI dialogs, RPC: JSON protocol, print: no-op). Include `pi.send()` for external message injection and a `branch()` utility for context selection. Hooks are configured via `settings.json` with a configurable timeout.

## Consequences

- Hooks provide a lower barrier to entry than a full SDK. Hook authors write a script, put it in a directory, and configure it in settings.
- `HookUIContext` ensures hooks work across all modes. A hook written for interactive mode also works in RPC mode, with UI prompts translated to JSON.
- `pi.send()` lets hook scripts inject arbitrary messages into the conversation, enabling integration with external systems (monitoring alerts, CI results, code review feedback).
- Hook timeout prevents runaway scripts from blocking the agent. Default timeout and settings override give control to the user.
- Hooks run synchronously in the agent's event loop. A blocking hook stalls the conversation until it completes or times out.

## Confidence

High. Commit body documents the architecture, and the hook types serve as the interface reference.
