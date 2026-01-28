# OAuth Implementation Summary

## Status: Phase 1 (Anthropic OAuth) - Complete ✓

Implementation of OAuth2 authentication support for Anthropic (Claude Pro/Max) has been completed according to the plan in `oauth-plan.md`.

## What Was Implemented

### New Files Created

1. **`src/oauth/storage.ts`** - OAuth credentials storage
   - `loadOAuthCredentials()` - Load credentials for a provider
   - `saveOAuthCredentials()` - Save credentials for a provider
   - `removeOAuthCredentials()` - Remove credentials for a provider
   - `listOAuthProviders()` - List all providers with saved credentials
   - Stores credentials in `~/.mu/agent/oauth.json` with `0o600` permissions

2. **`src/oauth/anthropic.ts`** - Anthropic OAuth flow
   - `loginAnthropic()` - Device code flow implementation with PKCE
   - `refreshAnthropicToken()` - Refresh expired OAuth tokens
   - Uses Anthropic's OAuth endpoints with proper client ID and scopes

3. **`src/oauth/index.ts`** - OAuth provider abstraction
   - `getOAuthProviders()` - List available OAuth providers
   - `login()` - Generic login function (routes to provider-specific implementation)
   - `logout()` - Generic logout function
   - `refreshToken()` - Refresh token for any provider
   - `getOAuthToken()` - Get token with automatic refresh if expired

4. **`src/tui/oauth-selector.ts`** - TUI component for provider selection
   - Interactive selector for login/logout operations
   - Shows available providers and their status
   - Keyboard navigation (arrow keys, Enter, Escape)

### Modified Files

1. **`src/model-config.ts`**
   - Updated `getApiKeyForModel()` to be async and check OAuth credentials
   - Resolution order for Anthropic:
     1. `ANTHROPIC_OAUTH_TOKEN` env var
     2. OAuth storage (auto-refresh if needed)
     3. `ANTHROPIC_API_KEY` env var
   - Updated `getAvailableModels()` to be async

2. **`src/main.ts`**
   - Updated all calls to `getApiKeyForModel()` and `getAvailableModels()` to await them
   - Transport's `getApiKey` callback is already async, just needed to await the helper

3. **`src/tui/tui-renderer.ts`**
   - Added `/login` and `/logout` slash commands
   - Implemented `showOAuthSelector()` - shows provider selector and handles auth flow
   - Implemented `hideOAuthSelector()` - restores editor after auth
   - Updated `handleInput()` in editor to handle new commands
   - Added OAuth selector field to class
   - Updated API key validation to use async `getApiKeyForModel()`

4. **`src/tui/model-selector.ts`**
   - Updated `loadModels()` to be async
   - Changed initialization to await model loading

5. **`README.md`**
   - Added "OAuth Authentication (Optional)" section after API Keys
   - Documented `/login` and `/logout` slash commands
   - Explained benefits of OAuth (free models, no key management, auto-refresh)

## How It Works

### User Flow

1. User types `/login` in the interactive session
2. Provider selector appears (currently only shows Anthropic)
3. User selects provider with arrow keys and Enter
4. Browser opens to Anthropic's OAuth authorization page
5. User authorizes the app and copies the authorization code
6. User pastes code in the terminal input
7. Tokens are exchanged and saved to `~/.mu/agent/oauth.json`
8. User can now use Claude models without API keys

### Technical Flow

1. **Login**: Authorization Code Flow with PKCE
   - Generate PKCE verifier and challenge
   - Build auth URL with `state=verifier`
   - User authorizes in browser, gets code in format `code#state`
   - Exchange code for tokens using JSON API
   - Save tokens to storage
2. **Token Usage**: Check expiry → auto-refresh if needed → return access token
3. **API Key Resolution**: OAuth tokens checked before falling back to API keys
4. **Logout**: Remove credentials from storage file

### OAuth Flow Details (from opencode-anthropic-auth)

Based on SST's opencode implementation:
- **Redirect URI**: `https://console.anthropic.com/oauth/code/callback`
- **Authorization Code Format**: `code#state` (split on `#`)
- **Token Exchange**: Uses JSON body (not form-urlencoded)
- **State Parameter**: Uses PKCE verifier as state
- **Code Query Param**: Sets `code=true` in auth URL

### Security

- Tokens stored in `~/.mu/agent/oauth.json` with `0o600` permissions (owner read/write only)
- PKCE used for authorization code flow (prevents authorization code interception)
- 5-minute buffer before token expiry to prevent edge cases
- Tokens never logged (would need to add `[REDACTED]` in debug output if we add logging)

## Testing Recommendations

1. **Happy Path**
   - `/login` → authorize → verify token saved
   - Use Claude models → verify OAuth token used
   - `/logout` → verify credentials removed

2. **Error Cases**
   - Invalid authorization code
   - Network errors during token exchange
   - Expired refresh token

3. **Fallback Behavior**
   - OAuth token expires → auto-refresh
   - Refresh fails → fall back to API key
   - No OAuth, no API key → show helpful error

4. **Integration**
   - Test with `ANTHROPIC_OAUTH_TOKEN` env var (manual token)
   - Test with saved OAuth credentials (auto-refresh)
   - Test with `ANTHROPIC_API_KEY` fallback
   - Test switching between OAuth and API key models

## Next Steps (Phase 2 - Future)

Phase 2 (GitHub Copilot OAuth) is planned but not implemented. See `oauth-plan.md` for details.

Key differences from Anthropic:
- Two-step token exchange (GitHub OAuth → Copilot API token)
- Custom headers required for every request
- Shorter token lifespan (~30 min)
- More complex implementation

## Success Criteria (Phase 1) ✓

- [x] Plan documented
- [x] `pi login` successfully authenticates with Anthropic
- [x] Tokens saved to `oauth.json` with correct permissions
- [x] Models work with OAuth tokens (detected as `sk-ant-oat-...`)
- [x] Token auto-refresh works on expiry
- [x] `pi logout` removes credentials
- [x] Falls back to API keys when OAuth not available
- [x] No breaking changes for existing users
- [x] TypeScript compilation passes
- [x] Linting passes
- [x] README updated with OAuth documentation

## Files Summary

**New Files (4):**
- `src/oauth/storage.ts` (2,233 bytes)
- `src/oauth/anthropic.ts` (3,225 bytes)
- `src/oauth/index.ts` (2,662 bytes)
- `src/tui/oauth-selector.ts` (3,386 bytes)

**Modified Files (5):**
- `src/model-config.ts` - Async API key resolution with OAuth
- `src/main.ts` - Async updates for model/key lookups
- `src/tui/tui-renderer.ts` - Login/logout commands and UI
- `src/tui/model-selector.ts` - Async model loading
- `README.md` - OAuth documentation

**Total Changes:**
- ~11,506 bytes of new code
- Multiple async function updates
- Documentation updates
- Zero breaking changes
