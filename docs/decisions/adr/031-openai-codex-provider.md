# 031: OpenAI Codex OAuth Provider

**Date:** 2026-01-24
**Source:** Commit `1650041a`

## Context

OpenAI released Codex, a coding-specialized model family, with its own API that didn't fit the existing provider patterns. Codex had OAuth-based authentication, a separate API endpoint, unique request/response formats, and required specialized prompt engineering (bridge prompts, instruction documents). The existing provider abstraction (ADR-003) assumed key-based auth and standard message formats. Codex also introduced session-based caching with `prompt_cache_key` and routing headers that no other provider used.

## Decision

Add a dedicated `openai-codex-responses` provider with its own OAuth flow, request transformer, response handler, and prompt templates. Implement session-based caching via `sessionId` in `StreamOptions` that the Codex provider uses for `prompt_cache_key` and routing headers. Mark the provider as experimental in documentation. Experimental means breaking changes aren't breaking.

## Consequences

- Codex users get native support with OAuth login and optimized prompts instead of configuring a generic OpenAI-compatible endpoint.
- The Codex provider is the first to use `sessionId` for caching, adding a new capability to the provider interface that other providers could adopt.
- The provider requires ~600 lines of implementation plus 350 lines of prompt templates. Significantly more than the Mistral provider (ADR-022) which reused the OpenAI-compat path.
- Session-based caching ties the provider to the agent's session lifecycle. Switching sessions clears the cache context.
- Marking as experimental means the API and behavior can change without a breaking change notice.

## Confidence

High. Commit body and implementation files document the architecture.
