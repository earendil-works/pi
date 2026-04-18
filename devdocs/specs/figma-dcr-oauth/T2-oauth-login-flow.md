# T2: Full OAuth Login Flow with DCR Credentials

## Objective
Implement the complete OAuth Authorization Code + PKCE flow for Figma MCP using DCR-issued client credentials.

## Depends On
- T1: DCR with "Codex" client_name (completed)

## Inputs
- DCR-issued client_id and client_secret (from T1)
- Figma authorization endpoint: `https://www.figma.com/oauth/mcp`
- Figma token endpoint: `https://api.figma.com/v1/oauth/token`
- Default redirect_uri: `http://127.0.0.1:8788/callback`

## Outputs
- Complete `loginFigmaMcp()` function that:
  1. Checks for existing client credentials (or calls DCR)
  2. Starts local callback server
  3. Generates PKCE verifier/challenge
  4. Builds authorization URL
  5. Exchanges code for tokens
  6. Stores tokens with client credentials

## Spec

### 1. Update loginFigmaMcp function

File: `packages/coding-agent/src/oauth/figma-mcp.ts`

```typescript
export async function loginFigmaMcp(
  onAuth: (info: OAuthAuthInfo) => void,
  onProgress?: (message: string) => void,
  config?: McpConfig,
): Promise<void> {
  const mcpConfig = config ?? (await loadMcpConfig());
  
  // Step 1: Get or register client credentials
  let clientConfig: FigmaOAuthClientConfig;
  const existingCreds = loadOAuthCredentials(FIGMA_PROVIDER_ID);
  
  if (existingCreds?.client_id && existingCreds?.client_secret) {
    // Use existing DCR credentials
    const figma = detectFigmaPilotServer(mcpConfig);
    clientConfig = {
      clientId: existingCreds.client_id,
      clientSecret: existingCreds.client_secret,
      redirectUri: "http://127.0.0.1:8788/callback",
      serverName: figma?.serverName ?? "figma",
      serverUrl: figma?.url ?? "https://mcp.figma.com/mcp"
    };
  } else {
    // Perform DCR to get new credentials
    onProgress?.("Registering Figma MCP client...");
    const { clientId, clientSecret } = await registerFigmaMcpClient();
    const figma = detectFigmaPilotServer(mcpConfig);
    clientConfig = {
      clientId,
      clientSecret,
      redirectUri: "http://127.0.0.1:8788/callback",
      serverName: figma?.serverName ?? "figma",
      serverUrl: figma?.url ?? "https://mcp.figma.com/mcp"
    };
  }
  
  // Step 2: Generate PKCE
  const { verifier, challenge } = await generatePKCE();
  const state = createState();
  
  // Step 3: Start callback server
  const { server, getCode } = await startCallbackServer(clientConfig.redirectUri, state);
  
  try {
    // Step 4: Build authorization URL
    const authUrl = new URL("https://www.figma.com/oauth/mcp");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientConfig.clientId);
    authUrl.searchParams.set("redirect_uri", clientConfig.redirectUri);
    authUrl.searchParams.set("scope", "mcp:connect");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    
    onAuth({
      url: authUrl.toString(),
      instructions: "Complete Figma authorization in your browser."
    });
    onProgress?.("Waiting for Figma OAuth callback...");
    
    // Step 5: Wait for callback
    const code = await getCode();
    onProgress?.("Exchanging authorization code for tokens...");
    
    // Step 6: Exchange code for tokens
    const { authorizationServer } = await discoverFigmaOAuthMetadata();
    const credentials = await exchangeCodeForToken(
      code,
      verifier,
      clientConfig,
      authorizationServer
    );
    
    // Step 7: Store with client credentials preserved
    saveOAuthCredentials(FIGMA_PROVIDER_ID, {
      ...credentials,
      client_id: clientConfig.clientId,
      client_secret: clientConfig.clientSecret
    });
    
    onProgress?.("Figma MCP authentication complete!");
  } finally {
    server.close();
  }
}
```

### 2. Update exchangeCodeForToken to include client_secret

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
  
  // Figma DCR returns client_secret even for "token_endpoint_auth_method: none"
  // and requires it for token operations
  if (clientConfig.clientSecret) {
    params.set("client_secret", clientConfig.clientSecret);
  }
  
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json"
    },
    body: params
  });
  
  if (!response.ok) {
    throw new Error(`Token exchange failed: HTTP ${response.status}`);
  }
  
  const payload = await response.json();
  return {
    type: "oauth",
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: Date.now() + payload.expires_in * 1000 - 5 * 60 * 1000,
    client_id: clientConfig.clientId,
    client_secret: clientConfig.clientSecret
  };
}
```

### 3. Update refreshFigmaMcpToken to use client credentials

```typescript
export async function refreshFigmaMcpToken(
  refreshToken: string,
  config?: McpConfig
): Promise<OAuthCredentials> {
  const creds = loadOAuthCredentials(FIGMA_PROVIDER_ID);
  if (!creds?.client_id) {
    throw new Error("No client credentials stored for figma-mcp");
  }
  
  const { authorizationServer } = await discoverFigmaOAuthMetadata();
  
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.client_id
  });
  
  if (creds.client_secret) {
    params.set("client_secret", creds.client_secret);
  }
  
  const response = await fetch(authorizationServer.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json"
    },
    body: params
  });
  
  if (!response.ok) {
    throw new Error(`Token refresh failed: HTTP ${response.status}`);
  }
  
  const payload = await response.json();
  return {
    type: "oauth",
    access: payload.access_token,
    refresh: payload.refresh_token ?? refreshToken,
    expires: Date.now() + payload.expires_in * 1000 - 5 * 60 * 1000,
    client_id: creds.client_id,
    client_secret: creds.client_secret
  };
}
```

## Validation Contract

### Commands
```bash
npm run check
npm test -- packages/coding-agent/test/oauth/figma-mcp.test.ts
```

### Test Cases

1. **loginFigmaMcp uses existing credentials if present**
   ```typescript
   // Store existing credentials
   saveOAuthCredentials("figma-mcp", {
     type: "oauth",
     access: "old",
     refresh: "old-refresh",
     expires: 0,
     client_id: "existing-client-id",
     client_secret: "existing-client-secret"
   });
   
   // loginFigmaMcp should NOT call DCR
   await loginFigmaMcp(mockOnAuth, mockOnProgress);
   // Verify DCR was not called
   ```

2. **loginFigmaMcp performs DCR if no credentials**
   ```typescript
   // Clear credentials
   // loginFigmaMcp should call registerFigmaMcpClient
   ```

3. **Token exchange includes client_secret**
   ```typescript
   const params = buildExchangeParams(code, verifier, clientId, clientSecret);
   expect(params.get("client_id")).toBe(clientId);
   expect(params.get("client_secret")).toBe(clientSecret);
   ```

### Pass Criteria
- Full login flow works (DCR → auth → token exchange → storage)
- Token refresh uses stored client credentials
- Typecheck passes
- Tests pass

## Constraints
- Reuse existing PKCE and callback server code
- Keep client_id and client_secret in stored credentials
- Handle case where user already has valid tokens

## Deliverables
- Modified `packages/coding-agent/src/oauth/figma-mcp.ts`
- Updated tests
- `npm run check` output
- Test output
