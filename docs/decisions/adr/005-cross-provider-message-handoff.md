# 005: Cross-Provider Message Handoff Protocol

**Date:** 2025-09-01
**Source:** Commit `46b5800d`

## Context

The agent needed to switch providers mid-conversation. Use one model for reasoning (native thinking blocks), another for generation. The catch: every provider serializes messages differently: different content block shapes, different tool call ID formats, different role labels. Switch without conversion and you dump malformed messages into the next provider's API.

## Decision

A `transformMessages()` utility that rewrites conversation history for the target provider. When switching providers, thinking blocks become `<thinking>` tagged text. When staying within the same provider, native thinking blocks stay native. Tool call IDs get reformatted. The loss is bounded. Some content block types, like Anthropic's signature thinking blocks, simply don't exist on other providers — so there's always a ceiling on what survives a handoff.

## Consequences

- Multi-provider chains work without context loss. You can route reasoning through one provider and generation through another.
- Thinking blocks degrade gracefully on handoff. They become plain tagged text, which most providers still understand.
- The transform layer lives in `utils.ts` and grows with every new provider. Each new provider means another format to map.
- Not all combinations are lossless. A provider that doesn't support tool calls can't receive tool results, no matter how you transform.

## Confidence

High. Commit body and comprehensive handoff test suite document all provider combinations.
