# 013: Custom Providers via models.json

**Date:** 2025-11-16
**Source:** Commit `0c5cbd00`

## Context

The agent supported OpenAI, Anthropic, Google, and OpenRouter out of the box. Users with local or self-hosted models (Ollama, vLLM, LM Studio, custom proxies) had no way to use them. Each local setup has different API shapes (OpenAI-compatible, Anthropic-compatible, Google-compatible), different base URLs, and different model names. The generated model registry (ADR-004) only covered known public providers. Extending it to cover every possible local deployment wasn't feasible.

## Decision

Add `~/.pi/agent/models.json` as a user-configurable file that defines custom providers and models. Support all four API types (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`). Live-reload the file when the model selector opens. Validate the JSON against a schema and report precise field-level errors. When a session uses a model that no longer exists (deleted from models.json, API key removed), fall back gracefully to a default model.

## Consequences

- Users can plug in any OpenAI-compatible backend (Ollama, vLLM, LiteLLM, custom proxies) without waiting for an upstream provider implementation.
- Live reload means editing models.json and opening the model selector picks up changes immediately. No restart.
- Schema validation points at the exact field with a readable error. Better than staring at a 500.
- Graceful fallback prevents sessions from breaking when a custom model is removed or a local server goes down.
- The generated model registry and models.json coexist. Built-in providers stay in the generated file, custom ones in the user config. No conflicts because models.json providers are keyed by a user-chosen name.

## Confidence

High. Commit body and README documentation together explain the design, API types, validation, and fallback behavior.
