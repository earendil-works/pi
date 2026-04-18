# T1: Implement DCR with "Codex" client_name

## Objective
Implement Dynamic Client Registration (RFC 7591) for Figma MCP using `client_name: "Codex"` (open source, allowlisted by Figma).

## Context
- Figma DCR endpoint: `https://api.figma.com/v1/oauth/mcp/register`
- Testing confirms `client_name: "Codex"` is allowlisted and returns `client_id` + `client_secret`
- Codex is open source, so using its name is appropriate
- DCR returns fresh credentials each time

## DCR Request
```json
POST https://api.figma.com/v1/oauth/mcp/register
{
  "client_name": "Codex",
  "redirect_uris": ["http://127.0.0.1:8788/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "mcp:connect"
}
```

Returns:
```json
{
  "client_id": "...",
  "client_secret": "...",
  "client_id_issued_at": 1234567890,
  "client_secret_expires_at": 0,
  "client_name": "Codex",
  "redirect_uris": ["http://127.0.0.1:8788/callback"],
  "scope": "mcp:connect"
}
```

## Spec

### 1. Add DCR function to figma-mcp.ts

File: `packages/coding-agent/src/oauth/figma-mcp.ts`

```typescript
interface DcrResponse {
  client_id: string;
  client_secret: string;
  client_id_issued_at: number;
  client_secret_expires_at: number;
  client_name: string;
  redirect_uris: string[];
  scope: string;
}

export async function registerFigmaMcpClient(
  redirectUri: string = "http://127.0.0.1:8788/callback"
): Promise<{ clientId: string; clientSecret: string }> {
  const response = await fetch("https://api.figma.com/v1/oauth/mcp/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify({
      client_name: "Codex",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:connect"
    })
  });

  if (!response.ok) {
    throw new Error(`DCR failed: HTTP ${response.status}`);
  }

  const data = await response.json() as DcrResponse;
  
  // Store the credentials
  const existing = loadOAuthCredentials(FIGMA_PROVIDER_ID) || {
    type: "oauth" as const,
    refresh: "",
    access: "",
    expires: 0
  };
  saveOAuthCredentials(FIGMA_PROVIDER_ID, {
    ...existing,
    client_id: data.client_id,
    client_secret: data.client_secret
  });

  return { clientId: data.client_id, clientSecret: data.client_secret };
}
```

### 2. Update OAuthCredentials type (if not already done)

File: `packages/ai/src/utils/oauth/storage.ts`

```typescript
export interface OAuthCredentials {
  // ... existing fields
  client_id?: string;
  client_secret?: string;
}
```

### 3. Update token exchange to use stored client credentials

File: `packages/coding-agent/src/oauth/figma-mcp.ts`

Update `exchangeCodeForToken` and `refreshFigmaMcpToken` to include client_id and client_secret:

```typescript
async function exchangeCodeForToken(
  code: string,
  verifier: string,
  clientConfig: { clientId: string; clientSecret?: string; redirectUri: string },
  metadata: FigmaAuthorizationServerMetadata
): Promise<OAuthCredentials> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientConfig.clientId,
    redirect_uri: clientConfig.redirectUri,
    code_verifier: verifier
  });
  
  // DCR returns client_secret even for public clients - Figma requires it
  if (clientConfig.clientSecret) {
    params.set("client_secret", clientConfig.clientSecret);
  }
  
  // ... rest of function
}
```

### 4. Update login flow to check for existing credentials first

```typescript
export async function loginFigmaMcp(...): Promise<void> {
  // Check if we already have client credentials
  let clientConfig = resolveFigmaOAuthClientConfig(mcpConfig);
  
  if (!clientConfig.clientId) {
    // Perform DCR to get new credentials
    const { clientId, clientSecret } = await registerFigmaMcpClient(clientConfig.redirectUri);
    clientConfig = {
      ...clientConfig,
      clientId,
      clientSecret
    };
  }
  
  // Continue with OAuth flow using client credentials
  // ...
}
```

## Validation Contract

### Commands
```bash
npm run check
npm test -- packages/coding-agent/test/oauth/figma-mcp.test.ts
```

### Test Cases

1. **DCR succeeds with "Codex" client_name**
   ```typescript
   const result = await registerFigmaMcpClient("http://127.0.0.1:8788/callback");
   expect(result.clientId).toMatch(/^.{20,}$/);
   expect(result.clientSecret).toMatch(/^.{20,}$/);
   ```

2. **Credentials are stored after DCR**
   ```typescript
   await registerFigmaMcpClient();
   const creds = loadOAuthCredentials("figma-mcp");
   expect(creds?.client_id).toBeDefined();
   expect(creds?.client_secret).toBeDefined();
   ```

3. **Token exchange uses client credentials**
   ```typescript
   // After DCR, token exchange should include client_id and client_secret
   const params = buildTokenExchangeParams(code, verifier, clientId, clientSecret);
   expect(params.get("client_id")).toBe(clientId);
   expect(params.get("client_secret")).toBe(clientSecret);
   ```

### Pass Criteria
- DCR function works and returns credentials
- Credentials are stored in oauth.json
- Typecheck passes
- Tests pass

## Constraints
- Use "Codex" as client_name (open source, allowlisted)
- Store client_id and client_secret from DCR
- Minimal changes to existing code

## Deliverables
- Modified `packages/coding-agent/src/oauth/figma-mcp.ts`
- Modified `packages/ai/src/utils/oauth/storage.ts` (if needed)
- Tests for DCR functionality
- `npm run check` output
- Test output
