# T1: OAuth Storage Schema for Figma MCP Credentials

## Objective
Update OAuth storage to support Figma MCP credentials including `client_id` and `client_secret` alongside tokens.

## Inputs
- Existing OAuth credentials type in `packages/ai/src/utils/oauth/storage.ts`
- Existing Figma MCP OAuth implementation in `packages/coding-agent/src/oauth/figma-mcp.ts`

## Outputs
- Updated `OAuthCredentials` type with optional `client_id` and `client_secret` fields
- Updated `FigmaMcpOAuth` to store and retrieve client credentials
- Tests for new storage schema

## Spec

### 1. Update OAuthCredentials type

File: `packages/ai/src/utils/oauth/storage.ts`

Add optional fields for DCR-issued client credentials:

```typescript
export interface OAuthCredentials {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  scopes?: string[];
  enterpriseUrl?: string;
  projectId?: string;
  email?: string;
  accountId?: string;
  // New fields for DCR
  client_id?: string;
  client_secret?: string;
}
```

### 2. Update Figma MCP OAuth to use new schema

File: `packages/coding-agent/src/oauth/figma-mcp.ts`

The existing `saveOAuthCredentials(FIGMA_PROVIDER_ID, credentials)` should work with the extended schema.

### 3. Add helper functions for DCR credential storage

```typescript
export function getFigmaMcpClientCredentials(): { client_id: string; client_secret: string } | null {
  const credentials = loadOAuthCredentials(FIGMA_PROVIDER_ID);
  if (!credentials?.client_id || !credentials?.client_secret) {
    return null;
  }
  return {
    client_id: credentials.client_id,
    client_secret: credentials.client_secret
  };
}

export function saveFigmaMcpClientCredentials(clientId: string, clientSecret: string): void {
  const existing = loadOAuthCredentials(FIGMA_PROVIDER_ID) || {
    type: "oauth" as const,
    refresh: "",
    access: "",
    expires: 0
  };
  saveOAuthCredentials(FIGMA_PROVIDER_ID, {
    ...existing,
    client_id: clientId,
    client_secret: clientSecret
  });
}
```

## Validation Contract

### Commands
```bash
npm run check
npm test -- packages/ai/test/utils/oauth/storage.test.ts
npm test -- packages/coding-agent/test/oauth/figma-mcp.test.ts
```

### Test Cases

1. **Store and retrieve client credentials**
   ```typescript
   saveFigmaMcpClientCredentials("test-client-id", "test-client-secret");
   const creds = getFigmaMcpClientCredentials();
   expect(creds).toEqual({ client_id: "test-client-id", client_secret: "test-client-secret" });
   ```

2. **Existing token storage still works**
   ```typescript
   const credentials: OAuthCredentials = {
     type: "oauth",
     access: "test-access",
     refresh: "test-refresh",
     expires: Date.now() + 3600000,
     client_id: "test-client-id",
     client_secret: "test-client-secret"
   };
   saveOAuthCredentials("figma-mcp", credentials);
   const loaded = loadOAuthCredentials("figma-mcp");
   expect(loaded?.client_id).toBe("test-client-id");
   expect(loaded?.client_secret).toBe("test-client-secret");
   ```

3. **Returns null when client credentials not stored**
   ```typescript
   // Clear credentials
   saveOAuthCredentials("figma-mcp", { type: "oauth", access: "x", refresh: "y", expires: 0 });
   expect(getFigmaMcpClientCredentials()).toBeNull();
   ```

### Pass Criteria
- Typecheck passes
- All tests pass
- No breaking changes to existing OAuth storage behavior

## Constraints
- Keep the change small - only add fields, don't restructure
- Maintain backward compatibility with existing OAuth providers
- Don't add new files unless necessary

## Deliverables
- Modified `packages/ai/src/utils/oauth/storage.ts`
- Modified `packages/coding-agent/src/oauth/figma-mcp.ts`
- Test file updates if needed
- `npm run check` output
- Test run output
