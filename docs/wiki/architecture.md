# Architecture Overview

The easiest way to understand this repo is to start from the product surface a user touches, then drill down into the lower-level libraries that power it.

## Top-down mental model

### 1. `packages/coding-agent`

This is the main product entry point.

If you run `pi`, or run `./pi-test.sh` from the repo root, this is the package you are effectively entering. Its README is the richest user-facing document in the repo, so beginners should start there instead of starting at the lowest abstraction layer.

### 2. `packages/agent`

This package provides the stateful agent loop: message flow, tool execution, event streaming, steering, follow-up messages, and retry/continue behavior.

If `coding-agent` is the product shell, `agent` is the reusable runtime engine.

### 3. `packages/ai`

This package provides the provider-agnostic LLM layer: model discovery, provider handling, streaming events, tool-call parsing, token usage, costs, and cross-provider handoff.

If `agent` decides how an agent behaves over time, `ai` decides how the repo talks to model providers.

### 4. `packages/tui`

This is the terminal UI layer. It is important, but it is not the conceptual entry point for most beginners.

Read it when you need to understand how the CLI renders editors, overlays, markdown, lists, and input handling.

## Specialized packages

Once you understand the core stack, the other packages make more sense:

- `packages/web-ui` — reusable web components for browser chat interfaces built on the same agent foundations
- `packages/mom` — a Slack bot that uses the agent stack in a different operational environment
- `packages/pods` — a separate CLI for remote GPU pod and vLLM deployment workflows

## Package relationships

For beginners, the most useful dependency story is:

```text
coding-agent
  uses agent
    uses ai

coding-agent
  uses tui

web-ui
  uses agent + ai

mom
  composes coding-agent/agent concepts for Slack

pods
  is adjacent infrastructure, not part of the core coding-agent stack
```

## Recommended code reading order

For a newcomer who wants to read code, not just docs:

1. `packages/coding-agent/src/cli.ts`
2. `packages/coding-agent/src/main.ts`
3. `packages/coding-agent/src/core/sdk.ts`
4. `packages/coding-agent/src/core/agent-session.ts`
5. `packages/agent/src/agent.ts`
6. `packages/agent/src/agent-loop.ts`
7. `packages/ai/src/index.ts`
8. `packages/ai/src/stream.ts`

Only read `packages/tui` early if you are working on terminal behavior.

If you want the source-level walkthrough behind that list, read [Code Reading Map](./code-reading-map.md).

## Why this reading order works

A bottom-up explanation (`ai` first) is technically correct, but it is high-friction for beginners. The repo itself points people toward `packages/coding-agent` first, so the fastest ramp-up path is to follow that signal and only then descend into `agent` and `ai`.
