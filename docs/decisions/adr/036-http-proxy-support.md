# 036: HTTP Proxy Support via Environment Variables

**Date:** 2026-02-08
**Source:** Commit `1e718e63`

## Context

Users behind corporate proxies or VPNs couldn't use pi because the AI provider SDKs (ADR-003) and git extension installer made direct HTTPS connections. The agent had no proxy configuration. Every outbound request went directly, and users had to set `HTTP_PROXY` env vars themselves hoping the underlying Node.js/Bun HTTP stack would pick them up. The provider SDKs (OpenAI, Anthropic, Google) each handled proxy differently or not at all.

## Decision

Read `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, and their lowercase variants from the environment. Pass the proxy URL through to all provider SDKs that support it. Use the proxy for all outbound HTTP requests made by the agent: provider API calls, extension git operations, and OAuth token exchanges. Respect `NO_PROXY` for bypassing the proxy on specific hosts.

## Consequences

- Users behind proxies set `HTTPS_PROXY` once and every provider, git operation, and OAuth flow uses it. No per-provider proxy configuration.
- The proxy setting is environment-wide rather than per-provider, which means users who need different proxies for different providers (e.g., direct to OpenAI, proxied to Anthropic) must rely on `NO_PROXY` patterns.
- Git operations now respect the proxy, which previously failed in corporate environments when cloning extension repos.

## Confidence

High. Commit body and the proxy integration across providers document the approach.
