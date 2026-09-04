---
name: add-llm-provider
description: Add or update an LLM provider in the native Rust pi-ai catalog and coding agent.
---

# Add an LLM provider

1. Add API, model, auth, cost, context-window, and capability metadata in `packages/ai/src/catalog.rs` and `types.rs`.
2. Reuse the HTTP adapters in `http.rs`; add a dedicated Rust `Provider` only when the wire protocol differs, as Bedrock does.
3. Resolve API keys, OAuth, regional settings, custom endpoints, cancellation, and response errors without exposing secrets.
4. Add deterministic SSE or provider-event tests under `packages/ai/tests` for text, reasoning, tool calls, usage, abort, and malformed responses.
5. Add model resolution and environment documentation under `packages/coding-agent/docs/providers.md`.
6. Run workspace formatting, Clippy with warnings denied, tests, and an isolated CLI smoke test.
