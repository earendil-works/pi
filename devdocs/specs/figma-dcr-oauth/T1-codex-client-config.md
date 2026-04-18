# T1: Configure Figma MCP with Codex Client ID

## Objective
Configure Figma MCP OAuth to use Codex's open-source client_id, eliminating the need for DCR. Update mcp.json to use the known working client_id.

## Context
- Codex's Figma MCP client_id: `i4EeYxBa9EpRaIzNQOBqYR` (open source, publicly available)
- Figma MCP OAuth requires client_id for token operations
- This client_id is used by Codex (OpenAI's CLI) and works with Figma's allowlist

## Inputs
- Current mcp.json: `~/.mu/agent/mcp.json`
- Codex config showing client_id usage

## Outputs
- Updated mcp.json with Codex client_id
- OAuth implementation that uses this client_id for all token operations
- Working Figma MCP authentication

## Spec

### 1. Update mcp.json configuration

File: `~/.mu/agent/mcp.json`

```json
{
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp",
      "oauth": {
        "clientId": "i4EeYxBa9EpRaIzNQOBqYR"
      }
    }
  }
}
```

Note: No `clientSecretEnv` needed - Codex's client works as a public client with PKCE.

### 2. Update OAuth implementation to use configured client_id

File: `packages/coding-agent/src/oauth/figma-mcp.ts`

The `resolveFigmaOAuthClientConfig` function already reads `oauth.clientId` from config. Ensure it works without requiring `clientSecret`:

```typescript
export function resolveFigmaOAuthClientConfig(config: McpConfig): FigmaOAuthClientConfig {
  const figma = detectFigmaPilotServer(config);
  if (!figma) {
    throw new Error("No Figma MCP server configured.");
  }

  const definition = config.mcpServers[figma.serverName];
  const oauth = definition?.oauth;
  const clientId = oauth?.clientId ?? getEnvValue("MU_FIGMA_OAUTH_CLIENT_ID");
  
  if (!clientId) {
    throw new Error("No Figma OAuth client_id configured.");
  }

  // For public clients (like Codex's), no secret is needed with PKCE
  const clientSecret = oauth?.clientSecret ?? getEnvValue(oauth?.clientSecretEnv) ?? undefined;

  return {
    clientId,
    clientSecret,  // Optional - public clients don't need this
    redirectUri: oauth?.redirectUri ?? "http://127.0.0.1:8788/callback",
    serverName: figma.serverName,
    serverUrl: figma.url
  };
}
```

### 3. Ensure token exchange works without client_secret

For public clients using PKCE, Figma should accept token requests with just `client_id` and PKCE `code_verifier`.

If Figma requires client_secret even for PKCE, we may need to investigate further.

## Validation Contract

### Commands
```bash
npm run check
npm test -- packages/coding-agent/test/oauth/figma-mcp.test.ts
```

### Manual Verification

1. Verify mcp.json has correct client_id:
   ```bash
   cat ~/.mu/agent/mcp.json | grep -A5 figma
   ```

2. Test OAuth login flow:
   ```bash
   # In Mu session, run:
   /login figma-mcp
   # Complete browser authorization
   # Verify tokens are stored
   ```

3. Test MCP connection:
   ```bash
   # After login, verify Figma tools are available
   /mcp
   ```

### Test Cases

1. **resolveFigmaOAuthClientConfig returns correct clientId**
   ```typescript
   const config = {
     mcpServers: {
       figma: {
         url: "https://mcp.figma.com/mcp",
         oauth: { clientId: "i4EeYxBa9EpRaIzNQOBqYR" }
       }
     }
   };
   const result = resolveFigmaOAuthClientConfig(config);
   expect(result.clientId).toBe("i4EeYxBa9EpRaIzNQOBqYR");
   expect(result.clientSecret).toBeUndefined();  // Public client
   ```

2. **Token refresh works with clientId only (if Figma supports it)**
   - This is the key verification point
   - If it fails, we know we need the client_secret

### Pass Criteria
- mcp.json configured with Codex client_id
- Typecheck passes
- Tests pass
- OAuth login can be initiated
- If token exchange fails, report the exact error for next step

## Constraints
- Minimal changes - just configure client_id
- Don't add new code unless needed
- Report any Figma API errors exactly

## Deliverables
- Updated mcp.json
- Any code changes to oauth/figma-mcp.ts
- `npm run check` output
- Test output
- Report on whether token exchange works with clientId only
