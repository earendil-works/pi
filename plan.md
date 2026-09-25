# Plan: Actionable handling for MCP OAuth "Incompatible auth server: does not support dynamic client registration"

## Problem statement
When a user runs Pi with an MCP server that requires OAuth, e.g. GitHub, Pi reports:
```
Error: Failed to authenticate "github": Incompatible auth server: does not support dynamic client registration
```
The error is thrown by the MCP SDK/client during the Client-Initiated Dynamic Client Registration step. GitHub OAuth does not support dynamic client registration, so the flow fails with a raw SDK error.

Current behavior:
* User sees a raw SDK error string with no remediation.
* No fallback to static client credentials or manual auth-start.
* Issue is reported across the MCP ecosystem, e.g. anthropics/claude-plugins-official/issues/283, getkimchi/kimchi/pull/1212.

## Goal
Make Pi detect this specific OAuth failure, surface an actionable error, and guide the user to the correct remediation. Optionally, automatically fall back to a static client / manual flow for known servers like GitHub.

## Root cause
* MCP OAuth client attempts dynamic client registration by default.
* GitHub and several enterprise OAuth providers do not support dynamic registration.
* Pi bubbles up the SDK error without mapping it to user guidance.

## Proposed solution
### 1. Error detection and mapping
* In Pi's MCP client/auth layer, catch errors containing:
  * `Incompatible auth server`
  * `does not support dynamic client registration`
* Map to a structured error type: `MCPOAuthDynamicRegistrationUnsupported`

### 2. User-facing message
Replace raw SDK error with:
```
Failed to authenticate "github" via OAuth.

Reason: The auth server does not support dynamic client registration.

Fix:
1. Use a pre-registered OAuth app for GitHub:
   - Set MCP_GITHUB_CLIENT_ID and MCP_GITHUB_CLIENT_SECRET in your Pi config, or
   - Run `pi mcp auth-start github` to start a manual device flow with static credentials.
2. If you control the MCP server config, ensure `clientRegistrationEndpoint` is set to null / disabled for GitHub.

See docs: <link to MCP OAuth setup>
```
The message should be printed in both interactive and JSON/RPC modes.

### 3. Optional auto-fallback
For known servers with a static client registry, e.g. `github`, `slack`, Pi can:
* Detect the error
* Retry authentication with `dynamicClientRegistration: false`
* Prompt user for client ID/secret if missing

This fallback is opt-in via config flag `mcp.oauth.fallbackToStatic`.

### 4. Telemetry
Emit a telemetry event `mcp.oauth.dynamic_registration_unsupported` with server name for tracking.

## Implementation plan
### Files to touch
* `packages/client/src/transport.ts` – MCP client transport / auth wrapper
* `packages/coding-agent/src/core/agent-session.ts` – error surfacing in agent session
* `packages/protocol/src/mcp/auth.ts` – if exists, otherwise new file `packages/client/src/mcp/oauth-errors.ts`
* Docs: `docs/mcp-auth.md`

### Steps
1. Reproduce
   * Configure a GitHub MCP server with OAuth and no static client.
   * Confirm error message appears.
2. Add error type
   * Create `MCPOAuthError` enum and mapping function `mapMcpOAuthError(err)`.
3. Add detection logic
   * In auth wrapper, catch error, check message regex `/Incompatible auth server.*does not support dynamic client registration/i`
   * Return structured error.
4. Update UI layer
   * In interactive mode, render actionable message with commands.
   * In JSON/RPC mode, return structured error object.
5. Add fallback config
   * Read `mcp.oauth.fallbackToStatic` from config.
   * If enabled and server is in allowlist, retry with `dynamicClientRegistration: false`.
6. Tests
   * Unit test for error mapping.
   * Integration test with mocked MCP server returning the error.
   * Test fallback path.
7. Docs update
   * Add troubleshooting section for GitHub OAuth.
8. PR
   * Open PR against `earendil-works/pi` with changes, tests, docs.

## Acceptance criteria
* Raw SDK error no longer shown to user.
* User sees clear remediation steps for GitHub.
* No regression in existing OAuth flows.
* Tests pass: `npm run check && ./test.sh`

## Risks
* Different MCP SDK versions may change error message wording → use regex + fallback.
* Auto-fallback may hide config issues → keep opt-in.

## Open source contribution
* PR will be raised in `earendil-works/pi` with `plan.md` linked.
* Contribution follows `CONTRIBUTING.md` guidelines.
