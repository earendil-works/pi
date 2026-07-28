# 016: Coding Agent Refactor into AgentSession Architecture

**Date:** 2025-12-09
**Source:** Commit `3f305502` → `dcf81a6a` (17 WP commits + merge)

## Context

The coding agent had grown organically from the original agent package. State management, session handling, bash execution, compaction, model management, and UI rendering were mixed across `main.ts`, `tui-renderer.ts`, and various modules. Adding features (bash mode, hooks, RPC) required touching multiple files and risked regressions. The architecture needed clear boundaries: a core session API that all modes (interactive, print, RPC) consumed uniformly.

## Decision

Extract an `AgentSession` class in `core/agent-session.ts` that encapsulates all agent state and operations: prompting, queuing, aborting, resetting, compaction, bash execution, model/thinking management, session persistence, and event subscription. Build three mode implementations on top: `InteractiveMode` (TUI), `PrintMode` (stdout), `RPCMode` (JSON protocol). Organize into `core/`, `utils/`, `modes/` directories. Implement in 17 planned work packages (WP1–WP17) over two days, each adding one piece of functionality, then move old files aside and rename the new ones.

## Consequences

- `AgentSession` provides a single API surface that all modes consume. Adding a new mode (say, a web socket mode) means implementing the mode instead of modifying the agent core.
- The WP-by-WP approach meant each commit was reviewable and testable independently. The refactor landed with minimal regression despite touching nearly every file.
- RPC mode (ADR-017), hooks (ADR-018), and bash mode (ADR-015) all became cleaner because they target `AgentSession` instead of scattered internals.
- The refactor took two days of concentrated work. The team accepted the risk of a big-bang rename at the end (WP14–WP17) rather than a gradual migration. Doesn't always work, but here it did.
- Some technical debt from the old architecture (circular dependencies in transports, mixed concerns in tui-renderer) was addressed in the refactor rather than carried forward.

## Confidence

High. The WP commit messages and the AGENTS.md code map document the architecture and migration strategy.
