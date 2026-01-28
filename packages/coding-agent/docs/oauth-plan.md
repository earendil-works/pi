# OAuth Support Plan

Add OAuth2 authentication for Anthropic (Claude Pro/Max) and GitHub Copilot to enable free model access for users with subscriptions.

## Overview

Many users have Claude Pro/Max or GitHub Copilot subscriptions but can't use them with pi because it requires API keys. This plan adds OAuth support to allow these users to authenticate with their existing subscriptions.

**Current limitations:**
- Anthropic: Requires paid API keys (`sk-ant-api03-...`)
- GitHub Copilot: Not supported at all

**After implementation:**
- Anthropic: Support OAuth tokens (`sk-ant-oat-...`) from Claude Pro/Max subscriptions
- GitHub Copilot: Support OAuth tokens from Copilot Individual/Business/Enterprise subscriptions

## Phase 1: Anthropic OAuth (Initial Implementation)

We'll start with Anthropic OAuth because:
1. The `@kennyfrc/mu-ai` Anthropic provider already handles OAuth tokens (checks for `sk-ant-oat` prefix)
2. No custom headers needed - just return the token
3. Simpler flow - only needs refresh token exchange

### Authentication Flow

1. **Device Code Flow (OAuth2 PKCE)**
   - Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
   - Authorization URL: `https://claude.ai/oauth/authorize`
   - Token URL: `https://console.anthropic.com/v1/oauth/token`
   - Scopes: `org:create_api_key user:profile user:inference`

2. **User Experience**
   ```bash
   $ pi login
   # Shows selector: "Anthropic (Claude Pro/Max)"
   # Opens browser to https://claude.ai/oauth/authorize?code=...
   # User authorizes
   # Paste authorization code in terminal
   # Saves tokens to ~/.mu/agent/oauth.json
   # Success message shown
   ```

3. **Token Storage**
   - File: `~/.mu/agent/oauth.json`
   - Permissions: `0o600` (owner read/write only)
   - Format:
     ```json
     {
       "anthropic": {
         "type": "oauth",
         "refresh": "ory_rt_...",
         "access": "sk-ant-oat-...",
         "expires": 1734567890000
       }
     }
     ```

4. **Token Refresh**
   - Check expiry before each agent loop (with 5 min buffer)
   - Auto-refresh using refresh token if expired
   - Save new tokens back to `oauth.json`

### API Key Resolution Order

Modified `getApiKeyForModel()` for Anthropic:

1. Check `ANTHROPIC_OAUTH_TOKEN` env var (manual OAuth token)
2. Check `~/.mu/agent/oauth.json` for OAuth credentials (auto-refresh if needed)
3. Check `ANTHROPIC_API_KEY` env var (paid API key)
4. Fail with helpful error message

### Implementation Details

#### New Files

**`src/oauth/storage.ts`**
```typescript
export interface OAuthCredentials {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
}

export async function loadOAuthCredentials(provider: string): Promise<OAuthCredentials | null>
export async function saveOAuthCredentials(provider: string, creds: OAuthCredentials): Promise<void>
export async function removeOAuthCredentials(provider: string): Promise<void>
export async function listOAuthProviders(): Promise<string[]>
```

**`src/oauth/anthropic.ts`**
```typescript
export async function loginAnthropic(): Promise<void>
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials>
```

**`src/oauth/index.ts`**
```typescript
export type SupportedOAuthProvider = "anthropic" | "github-copilot";

export async function login(provider: SupportedOAuthProvider): Promise<void>
export async function logout(provider: SupportedOAuthProvider): Promise<void>
export async function refreshToken(provider: SupportedOAuthProvider): Promise<string>
```

#### Modified Files

**`src/model-config.ts`**
- Update `getApiKeyForModel()` to check OAuth credentials
- Add async token refresh logic
- Change return type to `Promise<string | undefined>`

**`src/main.ts`**
- Update `getApiKey` callback to be async
- Handle async `getApiKeyForModel()`

**`src/cli.ts`**
- Add `login` command (no args - shows selector)
- Add `logout` command (no args - shows selector)

**`README.md`**
- Document `pi login` and `pi logout` commands
- Explain OAuth vs API key authentication
- Update API Keys section with OAuth option

### CLI Commands

#### `pi login`

No arguments. Shows interactive selector to pick provider.

```bash
$ pi login

Select provider to login:
  > Anthropic (Claude Pro/Max)
    GitHub Copilot (coming soon)

Opening browser to authorize...
Paste the authorization code here: abc123def456...

✓ Successfully authenticated with Anthropic
  Tokens saved to ~/.mu/agent/oauth.json
```

Implementation:
1. Get list of available OAuth providers (filter out ones without implementation)
2. Show `SelectList` with provider names
3. Call provider-specific login flow
4. Save credentials
5. Show success message

#### `pi logout`

No arguments. Shows interactive selector to pick provider.

```bash
$ pi logout

Select provider to logout:
  > Anthropic (Claude Pro/Max)
    [no other providers logged in]

✓ Successfully logged out of Anthropic
  Credentials removed from ~/.mu/agent/oauth.json
```

Implementation:
1. Get list of logged-in providers from `oauth.json`
2. Show `SelectList` with logged-in providers
3. Confirm logout
4. Remove credentials
5. Show success message

### Dependencies

No new dependencies needed:
- Use built-in `crypto` for PKCE generation (copy from opencode)
- Use built-in `fetch` for OAuth calls
- Use existing `SelectList` for TUI

### Testing

1. **Manual Testing**
   - `pi login` → select Anthropic → authorize → verify token saved
   - `pi` → use Claude models → verify OAuth token used
   - Wait for token expiry → verify auto-refresh
   - `pi logout` → verify credentials removed
   - `pi` → verify falls back to API key

2. **Integration Testing**
   - Test with `ANTHROPIC_OAUTH_TOKEN` env var
   - Test with saved OAuth credentials
   - Test with `ANTHROPIC_API_KEY` fallback
   - Test token refresh on expiry

### Security

- Store tokens in `~/.mu/agent/oauth.json` with `0o600` permissions
- Never log tokens (use `[REDACTED]` in debug output)
- Clear credentials on logout
- Token refresh uses HTTPS only

## Phase 2: GitHub Copilot OAuth (Future)

### Why Later?

GitHub Copilot requires more work:
1. Custom `fetch` interceptor for special headers
2. Two-step token exchange (OAuth → Copilot API token)
3. More complex headers (`User-Agent`, `Editor-Version`, etc.)
4. Support for Enterprise deployments (different base URLs)

### Implementation Approach

#### Token Exchange Flow

1. **GitHub OAuth** (standard device code flow)
   - Client ID: `Iv1.b507a08c87ecfe98`
   - Get GitHub OAuth token

2. **Copilot Token Exchange**
   - Exchange GitHub token for Copilot API token
   - Endpoint: `https://api.github.com/copilot_internal/v2/token`
   - Returns short-lived token (expires in ~30 min)

#### Required Headers

```typescript
{
  "Authorization": `Bearer ${copilotToken}`,
  "User-Agent": "GitHubCopilotChat/0.32.4",
  "Editor-Version": "vscode/1.105.1",
  "Editor-Plugin-Version": "copilot-chat/0.32.4",
  "Copilot-Integration-Id": "vscode-chat",
  "Openai-Intent": "conversation-edits",
  "X-Initiator": "agent"  // or "user"
}
```

#### Custom Fetch

Need to add `customFetch` support to `ProviderTransport`:

```typescript
// In packages/ai/src/stream.ts or in coding-agent transport wrapper
export interface CustomFetchOptions {
  provider: string;
  url: string;
  init: RequestInit;
}

export type CustomFetch = (opts: CustomFetchOptions) => Promise<Response>;

// Then use it before calling provider APIs
if (customFetch && needsCustomFetch(provider)) {
  const response = await customFetch({ provider, url, init });
}
```

#### New Files

**`src/oauth/github-copilot.ts`**
```typescript
export async function loginGitHubCopilot(): Promise<void>
export async function refreshCopilotToken(githubToken: string): Promise<OAuthCredentials>
export async function createCopilotFetch(getAuth: () => Promise<OAuthCredentials>): CustomFetch
```

#### Storage Format

```json
{
  "github-copilot": {
    "type": "oauth",
    "refresh": "gho_...",           // GitHub OAuth token
    "access": "copilot_token_...",  // Copilot API token
    "expires": 1234567890000        // Copilot token expiry (short-lived)
  }
}
```

### Challenges

1. **Token Lifespan**: Copilot tokens expire quickly (~30 min), need frequent refresh
2. **Custom Headers**: Must inject special headers for every request
3. **Enterprise Support**: Different base URLs for GitHub Enterprise
4. **Vision Requests**: Special `Copilot-Vision-Request: true` header needed

## Migration Path

Users won't need to change anything:
1. Existing API key users continue working
2. OAuth is opt-in via `pi login`
3. Can switch between OAuth and API keys by setting env vars
4. Can use both (OAuth for Anthropic, API key for OpenAI, etc.)

## Documentation Updates

### README.md

Add new section after "API Keys":

```markdown
## OAuth Authentication (Optional)

If you have a Claude Pro/Max subscription, you can use OAuth instead of API keys:

\`\`\`bash
pi login
# Select "Anthropic (Claude Pro/Max)"
# Authorize in browser
# Paste code
\`\`\`

This gives you:
- Free access to Claude models (included in your subscription)
- No need to manage API keys
- Automatic token refresh

To logout:
\`\`\`bash
pi logout
\`\`\`

**Note:** OAuth tokens are stored in `~/.mu/agent/oauth.json` with restricted permissions (0600).
```

### Slash Commands Section

```markdown
### /login

Login with OAuth to use subscription-based models (Claude Pro/Max, GitHub Copilot):

\`\`\`
/login
\`\`\`

Opens an interactive selector to choose provider.

### /logout

Logout from OAuth providers:

\`\`\`
/logout
\`\`\`

Shows a list of logged-in providers to logout from.
```

## Timeline

### Phase 1 (Anthropic OAuth) - Estimated: 1 day
- [x] Write plan
- [ ] Implement OAuth storage (`storage.ts`)
- [ ] Implement Anthropic OAuth flow (`anthropic.ts`)
- [ ] Update `getApiKeyForModel()` 
- [ ] Add `pi login` command
- [ ] Add `pi logout` command
- [ ] Update README.md
- [ ] Test with real Claude Pro account
- [ ] Commit and publish

### Phase 2 (GitHub Copilot OAuth) - Estimated: 2-3 days
- [ ] Design custom fetch architecture
- [ ] Implement GitHub OAuth flow
- [ ] Implement Copilot token exchange
- [ ] Add custom headers interceptor
- [ ] Support Enterprise deployments
- [ ] Test with real Copilot subscription
- [ ] Update README.md
- [ ] Commit and publish

## Success Criteria

### Phase 1
- [x] Plan documented
- [ ] `pi login` successfully authenticates with Anthropic
- [ ] Tokens saved to `oauth.json` with correct permissions
- [ ] Models work with OAuth tokens (detected as `sk-ant-oat-...`)
- [ ] Token auto-refresh works on expiry
- [ ] `pi logout` removes credentials
- [ ] Falls back to API keys when OAuth not available
- [ ] No breaking changes for existing users

### Phase 2
- [ ] `pi login` successfully authenticates with GitHub Copilot
- [ ] Copilot models available in `/model` selector
- [ ] Requests include all required headers
- [ ] Token refresh works for short-lived tokens
- [ ] Enterprise deployments supported
- [ ] No breaking changes for existing users
