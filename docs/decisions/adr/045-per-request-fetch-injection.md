# 045: Per-Request Fetch Injection

**Date:** 2026-04-28
**Source:** Commit `027a5847`

## Context

The provider abstraction (ADR-003) used a fixed HTTP client for all API requests. Extensions and custom providers had no way to intercept or modify individual requests: add headers, route through a specific proxy, or replace the fetch implementation entirely. The HTTP proxy support (ADR-040) covered environment-level proxying but couldn't handle per-request requirements like request-specific auth headers or request-specific routing.

## Decision

Add a `fetch` option to `StreamOptions` that lets callers inject a custom fetch implementation per API request. When provided, the provider uses the injected fetch instead of its default HTTP client. The option propagates through the Models runtime (ADR-041) so all providers and all request types use the injected fetch.

## Consequences

- Extensions and custom providers can intercept, modify, or replace every API request. Adding headers, changing destinations, implementing custom retry logic.
- The `fetch` option is per-request, not global. Different requests can use different fetch implementations.
- The propagation through the Models runtime means the injection applies to chat, image generation, and any future API types uniformly.
- Callers must implement the full fetch interface. Simple use cases (adding a header) require wrapping the default fetch rather than passing a configuration object.

## Confidence

High. Single-purpose commit with clear implementation.
