# OAuth Testing Checklist

## Manual Testing Guide

### Prerequisites
- You need a Claude Pro or Claude Max subscription
- A web browser for OAuth authorization

### Test 1: Basic Login Flow
1. Start pi in interactive mode:
   ```bash
   pi
   ```

2. Type `/login` and press Enter

3. Expected: OAuth provider selector appears showing "Anthropic (Claude Pro/Max)"

4. Press Enter to select Anthropic

5. Expected:
   - Browser opens to https://claude.ai/oauth/authorize?...
   - Terminal shows "Paste the authorization code below:"

6. Authorize the app in the browser

7. Copy the authorization code from the browser

8. Paste the code in the terminal and press Enter

9. Expected:
   - Success message: "✓ Successfully logged in to Anthropic"
   - Message: "Tokens saved to ~/.mu/agent/oauth.json"

10. Verify file created:
    ```bash
    ls -la ~/.mu/agent/oauth.json
    ```
    Expected: File exists with permissions `-rw-------` (0600)

11. Verify file contents:
    ```bash
    cat ~/.mu/agent/oauth.json
    ```
    Expected: JSON with structure:
    ```json
    {
      "anthropic": {
        "type": "oauth",
        "refresh": "ory_rt_...",
        "access": "sk-ant-oat-...",
        "expires": 1234567890000
      }
    }
    ```

### Test 2: Using OAuth Token
1. With OAuth credentials saved (from Test 1), start a new pi session:
   ```bash
   pi
   ```

2. Type `/model` and press Enter

3. Expected: Claude models (e.g., claude-sonnet-4-5) appear in the list

4. Select a Claude model

5. Send a simple message:
   ```
   You: Hello, tell me what 2+2 is
   ```

6. Expected:
   - Model responds successfully
   - No "API key not found" errors
   - OAuth token is used automatically (check that it works without ANTHROPIC_API_KEY set)

### Test 3: Logout
1. In an interactive pi session, type `/logout`

2. Expected: OAuth provider selector shows "Anthropic (Claude Pro/Max)"

3. Press Enter to select Anthropic

4. Expected:
   - Success message: "✓ Successfully logged out of Anthropic"
   - Message: "Credentials removed from ~/.mu/agent/oauth.json"

5. Verify file is empty or doesn't contain anthropic:
   ```bash
   cat ~/.mu/agent/oauth.json
   ```
   Expected: `{}` or file doesn't exist

### Test 4: Token Auto-Refresh
This test requires waiting for token expiry (or manually setting a past expiry time).

1. Modify `~/.mu/agent/oauth.json` to set an expired time:
   ```json
   {
     "anthropic": {
       "type": "oauth",
       "refresh": "ory_rt_...",
       "access": "sk-ant-oat-...",
       "expires": 1000000000000
     }
   }
   ```

2. Start pi and send a message to a Claude model

3. Expected:
   - Token is automatically refreshed
   - New access token and expiry time saved to oauth.json
   - Request succeeds without user intervention

### Test 5: Fallback to API Key
1. Remove OAuth credentials:
   ```bash
   rm ~/.mu/agent/oauth.json
   ```

2. Set ANTHROPIC_API_KEY:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

3. Start pi and send a message to a Claude model

4. Expected:
   - Model uses API key successfully
   - No errors about missing OAuth credentials

### Test 6: OAuth Takes Priority
1. Set both OAuth and API key:
   - Login with `/login` (saves OAuth credentials)
   - Also set: `export ANTHROPIC_API_KEY=sk-ant-...`

2. Start pi and check which is used

3. Expected: OAuth token is used (verify in logs or by checking if API key would fail)

### Test 7: Error Handling - Invalid Code
1. Start pi and type `/login`

2. Select Anthropic

3. Enter an invalid authorization code (e.g., "invalid123")

4. Expected:
   - Error message shown
   - No credentials saved
   - Can try again

### Test 8: Error Handling - No Browser
1. Start pi in a headless environment or where browser can't open

2. Type `/login` and select Anthropic

3. Expected:
   - URL is shown in terminal
   - User can manually copy URL to browser
   - Auth flow continues normally

### Test 9: Slash Command Autocomplete
1. Start pi

2. Type `/` and press Tab

3. Expected: Autocomplete shows `/login` and `/logout` among other commands

4. Type `/log` and press Tab

5. Expected: Autocomplete completes to `/login` or `/logout`

### Test 10: No OAuth Available (Logout)
1. Ensure no OAuth credentials are saved:
   ```bash
   rm ~/.mu/agent/oauth.json
   ```

2. Start pi and type `/logout`

3. Expected:
   - Message: "No OAuth providers logged in. Use /login first."
   - Selector doesn't appear

## Automated Testing Ideas

The following tests should be added to the test suite:

1. **Unit Tests for `oauth/storage.ts`**
   - `saveOAuthCredentials()` creates file with correct permissions
   - `loadOAuthCredentials()` returns saved credentials
   - `removeOAuthCredentials()` removes credentials
   - `listOAuthProviders()` returns correct list

2. **Unit Tests for `oauth/anthropic.ts`**
   - PKCE generation creates valid verifier/challenge
   - Token refresh makes correct API call
   - Error handling for failed requests

3. **Integration Tests for `model-config.ts`**
   - `getApiKeyForModel()` checks OAuth before API key
   - Async behavior works correctly
   - Proper fallback to API keys

4. **Mock Tests for OAuth Flow**
   - Mock fetch to test token exchange
   - Test auto-refresh logic
   - Test expiry checking

## Known Limitations

1. **Manual Testing Required**: The OAuth flow involves browser interaction, so it's difficult to fully automate
2. **Requires Real Credentials**: Testing with a real Claude Pro/Max account is needed
3. **Token Expiry**: Default tokens last a long time, so auto-refresh is hard to test naturally

## Success Criteria

- [ ] All manual tests pass
- [ ] OAuth login works end-to-end
- [ ] Tokens are saved securely (0600 permissions)
- [ ] Token auto-refresh works
- [ ] Logout removes credentials
- [ ] Fallback to API keys works
- [ ] No breaking changes for existing API key users
- [ ] Error handling is user-friendly
- [ ] Documentation is clear and accurate
