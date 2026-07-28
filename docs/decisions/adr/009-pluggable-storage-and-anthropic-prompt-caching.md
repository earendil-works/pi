# 009: Pluggable Storage Architecture and Anthropic Prompt Caching

**Date:** 2025-10-05
**Source:** Commit `04966513` | Commit `bbbc232c`

## Context

The web UI accumulated three different storage backends (LocalStorage, Chrome Storage, IndexedDB) and two repository layers (settings, provider keys) with no unifying pattern. Each backend had a different API surface. Meanwhile, Anthropic introduced prompt caching — the system prompt and conversation history could be cached server-side, saving ~90% on input tokens for cached content — but it required sending `cache_control` markers on specific messages, which meant the storage layer had to be stable enough to support caching configuration.

## Decision

Consolidate all storage behind a single `StorageBackend` interface with one `IndexedDBStorageBackend` implementation (10GB+ quota). Store settings, provider keys, and sessions through this unified interface. On the Anthropic provider, mark the system prompt and last user message with `cache_control` markers to enable prompt caching. Remove the old backends and repository classes.

## Consequences

- One storage backend instead of four. New storage features (e.g., encrypted key storage) need one implementation.
- IndexedDB's 10GB quota handles long conversations with artifact blobs that Chrome Storage's 10MB couldn't.
- Anthropic prompt caching cuts input token costs by ~90% for cached segments. Meaningful for heavy users.
- The refactoring was done in two passes: first the caching + multi-backend system (04966513), then the consolidation to single backend (bbbc232c) ~3 days later. The intermediate state had unnecessary complexity.
- The cache markers assume the conversation starts with system prompt + user message. Deviations from this pattern may not cache as effectively.

## Confidence

High. both commits have detailed commit bodies explaining the motivation.
