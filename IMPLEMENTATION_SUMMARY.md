# Implementation Summary: Actionable MCP OAuth error handling

## What was implemented
Created a small error mapping layer for MCP OAuth failures, specifically for `Incompatible auth server: does not support dynamic client registration`.

Files added/changed:
* `packages/client/src/mcp/oauth-errors.ts` – error detection, mapping to structured error with actionable message
* `packages/client/src/mcp/auth-wrapper.ts` – example wrapper showing how to use the mapper
* `packages/client/src/mcp/oauth-errors.test.ts` – unit tests

## How it works
1. When authentication fails, `mapMcpOAuthError(err, serverName)` is called.
2. Regex detects dynamic registration unsupported message.
3. Returns structured error with code `MCP_OAUTH_DYNAMIC_REGISTRATION_UNSUPPORTED` and a user-friendly actionable message with remediation steps.
4. Wrapper logs actionable message and re-throws structured error for JSON/RPC.

## Tests
Run with:
```bash
cd packages/client
npm run test
```
Expected: `oauth-errors.test.ts` passes.

## Next steps for PR
* Integrate `authenticateMcpServer` wrapper into actual MCP client code in `packages/client` / `packages/coding-agent`.
* Add config flag `mcp.oauth.fallbackToStatic` and retry logic.
* Update docs `docs/mcp-auth.md` with troubleshooting section.
* Open PR against `earendil-works/pi` referencing `plan.md`.

## Notes
This is a minimal, non-breaking change that can be merged as-is for better error messages, with fallback logic added later.
