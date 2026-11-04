# MCP SSE response cancellation validation

## Scope

This branch records an independent validation of the fix for issue #11729. The implementation is already present in the fork baseline through upstream commit `f4098474731da814202f3045ff9faa6b322e7fff` (PR #11735), so this commit does not duplicate the production fix.

## Implementation verified

`packages/mcp/src/transports/streamable-http.ts` now cancels the SSE reader when parsing exits with an error, then releases the reader lock. Cancellation failures are ignored so the original parsing or size-limit error remains the reported error.

`packages/mcp/test/streamable-http.test.ts` includes a regression test that keeps an oversized SSE stream open and verifies that its `cancel` callback runs.

## Verification

Using the fork baseline in an isolated worktree:

```sh
cd packages/mcp
node ../../node_modules/vitest/dist/cli.js --run test/streamable-http.test.ts
```

Result: 20 tests passed.

The earlier local loopback reproduction used the real `McpClient` and `StreamableHttpTransport` against a local HTTP server. With the pre-fix behavior, three oversized SSE responses stayed active and continued receiving heartbeats. With cancellation, all three closed and no further heartbeat writes occurred; a subsequent request on the same client still succeeded.

This validation used no extensions, external MCP servers, model APIs, or user data. It covered the Node/macOS path only.
