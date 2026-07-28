# 020: OAuth Authentication for Claude Pro/Max

**Date:** 2025-11-18
**Source:** Commit `587d7c39`

## Context

The agent supported API key authentication for all providers via the unified provider abstraction (ADR-003). Anthropic also offered OAuth-based access for Claude Pro and Max subscribers, which gave users access to Claude models without managing API keys. The existing auth model (single env var or key input) didn't support OAuth flows. Tokens needed to be obtained, stored securely, and refreshed automatically.

## Decision

Add OAuth authentication with `/login` and `/logout` commands. Store tokens in `~/.pi/agent/oauth.json` with `0600` permissions. Auto-refresh tokens before expiry with a 5-minute buffer. Use a priority chain: OAuth token > `ANTHROPIC_OAUTH_TOKEN` env var > `ANTHROPIC_API_KEY` env var. Add bracketed paste support to the TUI `Input` component for pasting long OAuth codes.

## Consequences

- Claude Pro/Max subscribers can use the agent without API keys. Lowers the barrier for non-developer users.
- OAuth tokens stored at `0600` are readable only by the owner. Better security than API keys in env vars or shell history.
- Auto-refresh with a 5-minute buffer prevents mid-conversation auth failures. The agent refreshes before the token expires.
- The priority chain means OAuth takes precedence when configured, but API keys still work as fallback. No breaking change for existing users.
- Bracketed paste support in the `Input` component was a direct dependency of OAuth (long tokens), but also benefits any user pasting text into the TUI.

## Confidence

High. Commit body and the OAuth implementation docs (`docs/oauth-implementation-summary.md`) document the full flow.
