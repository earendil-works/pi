# T3: MCP Connection Integration

## Objective
Update Figma MCP connection to use OAuth access token for MCP operations. Wire the OAuth flow into the existing MCP infrastructure.

## Depends On
- T1: DCR with "Codex" client_name (completed)
- T2: Full OAuth login flow (completed)

## Inputs
- Stored OAuth access token from T2
- Existing MCP server manager in `packages/coding-agent/src/mcp/server-manager.ts`
- Existing Figma MCP extension in `packages/coding-agent/src/extensions/built-ins.ts`

## Outputs
- `getFigmaOAuthAccessToken()` returns valid access token (refreshing if needed)
- MCP server manager uses OAuth token for Figma connections
- `/login figma-mcp` command works in TUI

## Spec

### 1. Update getFigmaOAuthAccessToken to handle token refresh

File: `packages/coding-agent/src/oauth/figma-mcp.ts`

```typescript
export async function getFigmaOAuthAccessToken(config?: McpConfig): Promise<string | null> {
  const credentials = loadOAuthCredentials(FIGMA_PROVIDER_ID);
  if (!credentials) return null;
  
  // Check if we have client credentials for refresh
  if (!credentials.client_id || !credentials.client_secret) {
    // Old credentials without DCR - user needs to re-login
    return null;
  }
  
  // If token is still valid, return it
  if (Date.now() < credentials.expires) {
    return credentials.access;
  }
  
  // Token expired - refresh it
  try {
    const refreshed = await refreshFigmaMcpToken(credentials.refresh, config);
    saveOAuthCredentials(FIGMA_PROVIDER_ID, refreshed);
    return refreshed.access;
  } catch (error) {
    // Refresh failed - user needs to re-login
    console.error("Figma token refresh failed:", error);
    return null;
  }
}
```

### 2. Ensure MCP server manager uses OAuth token

File: `packages/coding-agent/src/mcp/server-manager.ts`

The `resolveHeaders` function already calls `getFigmaOAuthAccessToken()` for Figma URLs. Verify it works correctly.

### 3. Add login command integration (if not already present)

Verify that `/login figma-mcp` or equivalent command triggers `loginFigmaMcp()`.

The login flow should be accessible via:
- TUI command `/login figma-mcp`
- Or automatic when attempting to use Figma tools without auth

### 4. Update Figma status to reflect auth state

File: `packages/coding-agent/src/mcp/figma-pilot.ts`

```typescript
export function buildFigmaPilotStatus(input: FigmaPilotStatusInput): McpStatusSnapshot {
  if (!input.hasConfiguredServer) {
    return { state: "connected", connectedCount: 0, totalCount: 0 };
  }
  
  if (input.hasAuthenticatedConnection) {
    return {
      state: "connected",
      serverName: input.serverName,
      connectedCount: 1,
      totalCount: 1,
    };
  }
  
  // Check if we have stored OAuth credentials
  if (input.hasStoredCredentials) {
    return {
      state: "auth_expired",  // Credentials exist but connection not verified
      serverName: input.serverName,
      connectedCount: 0,
      totalCount: 1,
    };
  }
  
  return {
    state: "auth_required",
    serverName: input.serverName,
    connectedCount: 0,
    totalCount: 1,
  };
}
```

## Validation Contract

### Commands
```bash
npm run check
npm test -- packages/coding-agent/test/oauth/figma-mcp.test.ts
npm test -- packages/coding-agent/test/mcp/figma-pilot.test.ts
```

### Test Cases

1. **getFigmaOAuthAccessToken returns valid token**
   ```typescript
   // Store valid credentials
   saveOAuthCredentials("figma-mcp", {
     type: "oauth",
     access: "valid-access-token",
     refresh: "valid-refresh-token",
     expires: Date.now() + 3600000,
     client_id: "test-client-id",
     client_secret: "test-client-secret"
   });
   
   const token = await getFigmaOAuthAccessToken();
   expect(token).toBe("valid-access-token");
   ```

2. **getFigmaOAuthAccessToken refreshes expired token**
   ```typescript
   // Store expired credentials
   saveOAuthCredentials("figma-mcp", {
     type: "oauth",
     access: "expired-access-token",
     refresh: "valid-refresh-token",
     expires: Date.now() - 1000,  // Expired
     client_id: "test-client-id",
     client_secret: "test-client-secret"
   });
   
   const token = await getFigmaOAuthAccessToken();
   // Should have called refresh and returned new token
   expect(token).not.toBe("expired-access-token");
   ```

3. **MCP connection uses OAuth token**
   ```typescript
   // After OAuth login, MCP initialize should succeed
   const manager = new McpServerManager();
   await manager.connect("figma", { url: "https://mcp.figma.com/mcp" });
   // Connection should have used stored access token
   ```

### Pass Criteria
- `getFigmaOAuthAccessToken` handles token refresh
- MCP connections use OAuth token
- Typecheck passes
- Tests pass

## Constraints
- Don't break existing MCP infrastructure
- Handle token expiration gracefully
- Report auth failures clearly

## Deliverables
- Modified `packages/coding-agent/src/oauth/figma-mcp.ts`
- Modified `packages/coding-agent/src/mcp/figma-pilot.ts` (if needed)
- Tests updated
- `npm run check` output
- Test output
