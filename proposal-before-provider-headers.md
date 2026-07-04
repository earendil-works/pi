# Proposal: `before_provider_headers` extension hook

## What do you want to change?

Add a `before_provider_headers` extension hook so extensions can add, override, or remove outgoing provider request headers.

## Why?

Extension authors can already influence provider requests, but not the HTTP headers. That makes it hard to use LLM gateways or proxies that rely on headers for observability, billing attribution, or trace IDs.

A concrete use case is attributing LLM spend to a session or PR as the request passes through a gateway.

## How?

New `BeforeProviderHeadersEvent { headers: ProviderHeaders }` plus an `on("before_provider_headers", ...)` hook.

Design choices:

- **Mutate-in-place, return value ignored; a `null` value deletes a header.**
  This prevents a handler from accidentally dropping auth headers by forgetting to copy them.
- **Separate hook, not part of `before_provider_request`.** That hook runs during payload assembly and never sees headers.
- **Runs once per provider request; retries reuse the same headers.** Per-attempt headers would need a larger cross-package change, and the expected attribution values are stable across retries.

Already implemented in this PR. Comments welcome.
