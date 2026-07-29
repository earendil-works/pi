# 028: Shell Commands Without Context Contribution

**Date:** 2026-01-13
**Source:** Commit `746ec9eb`

## Context

The bash mode (`!` prefix, ADR-018) executed shell commands and included their output in the LLM context. This was useful for commands the LLM needed to know about. But many quick commands — `ls`, `git status`, `curl` a URL — produced output the user wanted to see without bloating the context window or distracting the model. There was no way to run a command silently.

## Decision

Add a `!!` prefix that executes shell commands like `!` but marks the execution as `excludeFromContext`. The command is shown in the TUI and saved to session history, but filtered out during `convertToLlm()`, compaction summarization, and branch summarization. Excluded commands render with a dimmed border in the TUI to distinguish them visually.

## Consequences

- Users can run utility commands without consuming context. Saves token budget for commands that don't need LLM awareness.
- Excluded commands are still visible in the TUI and session history. The user can refer back to them even though the model can't.
- Dimmed border provides clear visual feedback about which commands are excluded.
- The `excludeFromContext` field on `BashExecutionMessage` is a simple boolean flag that other message types could also use if the pattern proves useful.

## Confidence

High. Commit body documents the feature design, filtering logic, and visual treatment.
