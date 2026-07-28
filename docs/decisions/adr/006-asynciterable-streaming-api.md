# 006: AsyncIterable Streaming Generate API

**Date:** 2025-09-02
**Source:** Commit `004de3c9` | Commit `4cee070b`

## Context

The initial AI provider abstraction (ADR-003) used a callback-based streaming API: `onText`, `onThinking`, `onToolCall`. This worked for the TUI but was awkward for programmatic use. Consumers had to assemble state from scattered callbacks, and error handling mixed with stream events. The team also needed a `finalMessage()` result that included the complete response, but the callback API didn't return one cleanly.

## Decision

Replace the callback-based streaming with an `AsyncIterable`-based `generate()` API. A `QueuedGenerateStream` extends `AsyncIterable` and provides a `finalMessage()` method that resolves when the stream ends. Providers implement a `generateAnthropic`-style function rather than a class. Options like `apiKey` move from constructor parameters to per-call options.

## Consequences

- Callers can `for await (const event of stream)`. Idiomatic JS that works with the TUI's event loop.
- `finalMessage()` gives a clean complete response without manual state assembly
- Function-based provider implementations are simpler to test than class-based ones
- The old callback interface still works for the TUI but now wraps the new API, adding a thin translation layer
- Breaking change for anyone already using the callback API

## Confidence

High. commit body documents the motivation and alternatives.
