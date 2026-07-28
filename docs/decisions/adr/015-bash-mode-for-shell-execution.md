# 015: Bash Mode for Shell Command Execution

**Date:** 2025-12-08
**Source:** Commit `bd0d0676`

## Context

The agent could execute bash commands through tool calls, but this required the LLM to decide when to run something. Users who wanted to quickly run a command had no direct path — whether they didn't want to wait for the model or already knew what to run. The TUI had a text editor for prompts but no way to say "just run this, don't think about it." The refactored AgentSession API (ADR-016) made it possible to add bash as a first-class execution mode alongside prompting and queueing. The team also needed bash execution in RPC mode for programmatic use.

## Decision

Add a `!` prefix in the TUI editor: lines starting with `!` execute as shell commands directly. Output streams in real-time and gets included in LLM context. Commands support multiline input, Escape to cancel, truncation at 20-line preview (Ctrl+O expands full output). Commands persist in session history as `bashExecution` messages. Expose the same functionality in RPC mode via `{type:'bash', command:'...'}`.

## Consequences

- Users can run shell commands instantly without LLM latency. Good for quick checks, file operations, and iterative development.
- Command output is available to the LLM in subsequent turns. The model can see what the user ran and respond to it.
- The 20-line preview prevents runaway output from flooding the TUI. Full output is always accessible.
- Bash execution messages in session history mean compaction and export capture them alongside LLM conversations.
- The `!` prefix creates a potential ambiguity: messages starting with `!` that aren't commands (exclamations, markdown) need special handling.

## Confidence

High. Commit body documents the full feature, and the RPC integration tests cover the bash command protocol.
