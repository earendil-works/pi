# 003: Unified AI Provider Abstraction with Streaming-First API

**Date:** 2025-08-17
**Source:** Commit `f064ea0e`

## Context

Three providers, three SDKs, three API shapes. OpenAI uses events, Anthropic uses blocks, Gemini uses yet another stream format. The agent core shouldn't know about any of them. It should send a message and get tokens back, regardless of which provider is under the hood. The team also needed streaming from day one for the TUI: you can't wait for a full response to render.

## Decision

Build `@mariozechner/pi-ai` as a unified layer over the provider SDKs. Every provider implements the same `LLM` interface with `onText`, `onThinking`, `onToolCall` callbacks and a shared `Model` type for configuration. Provider-specific features — thinking blocks, image inputs, tool use — normalize into a common content block format. The streaming contract is event-based, not callback-chained.

## Consequences

- The agent core imports one package, not three. A config change. Streaming events hit the TUI as they arrive instead of the agent buffering a full response before rendering.
- Provider-specific capabilities have to fit the common block model. If a provider ships a unique feature, the interface has to stretch or drop it.
- Each new provider means a full `LLM` implementation. There is no partial-adapter path, and because each provider's SDK upgrade stays contained in its own file, when Anthropic breaks their SDK you fix a single file rather than the whole agent.

## Confidence

High. The commit body and accompanying analysis documents document the provider investigation and design decisions.
