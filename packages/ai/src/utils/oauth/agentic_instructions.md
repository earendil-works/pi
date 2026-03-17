# packages/ai/src/utils/oauth

## Purpose
OAuth authentication flows for LLM providers: Anthropic, GitHub Copilot, Google Gemini CLI, Google Antigravity, and OpenAI Codex. Handles login, token refresh, and PKCE challenge generation.

## Technology
TypeScript, ESM modules. HTTP-based OAuth token exchange with local callback servers for browser-based authorization flows.

## Contents
- `index.ts` - Barrel export of all OAuth providers and the `oauthProviders` registry map
- `types.ts` - Core OAuth type definitions: `OAuthCredentials`, `OAuthProviderId`, `OAuthPrompt`, `OAuthAuthInfo`, `OAuthLoginCallbacks`, `OAuthProviderInterface`
- `pkce.ts` - `generatePKCE()`: PKCE code verifier/challenge generation using `crypto.subtle`
- `anthropic.ts` - Anthropic OAuth provider: browser-based PKCE flow via `claude.ai/oauth/authorize`, local callback on port 53692
- `github-copilot.ts` - GitHub Copilot device code flow: polls for token, discovers Copilot-compatible models
- `google-gemini-cli.ts` - Google Gemini CLI OAuth: browser-based flow via Google OAuth2, targets Cloud Code Assist endpoint
- `google-antigravity.ts` - Google Antigravity OAuth: browser-based flow for Gemini models via Google OAuth2
- `openai-codex.ts` - OpenAI Codex OAuth: browser-based PKCE flow via `auth.openai.com`, local callback on port 1455

## Key Functions
- `loginAnthropic(callbacks)`: Start Anthropic OAuth login flow. Returns `OAuthCredentials`
- `refreshAnthropicToken(credentials)`: Refresh Anthropic OAuth token
- `loginGithubCopilot(callbacks)`: Start GitHub Copilot device code flow. Returns `CopilotCredentials`
- `refreshGithubCopilotToken(credentials)`: Refresh Copilot token
- `loginGeminiCli(callbacks)`: Start Google Gemini CLI OAuth flow. Returns `GeminiCredentials`
- `loginAntigravity(callbacks)`: Start Google Antigravity OAuth flow. Returns `AntigravityCredentials`
- `loginOpenAICodex(callbacks)`: Start OpenAI Codex OAuth flow. Returns `OAuthCredentials`
- `generatePKCE()`: Generate PKCE verifier and challenge pair

## Data Types
- `OAuthCredentials`: `{ accessToken, refreshToken?, expiresAt? }`
- `OAuthProviderId`: string identifier for OAuth provider
- `OAuthPrompt`: `{ type: "url" | "code", url?, code?, message? }`
- `OAuthAuthInfo`: `{ provider, scopes, expiresAt? }`
- `OAuthLoginCallbacks`: `{ onPrompt, onSuccess?, onError? }`
- `OAuthProviderInterface`: `{ id, name, login, refresh?, getModels? }`
- `CopilotCredentials` (github-copilot.ts): extends `OAuthCredentials` with `copilotToken`, `copilotTokenExpiry`
- `GeminiCredentials` (google-gemini-cli.ts): extends `OAuthCredentials` with `idToken`
- `AntigravityCredentials` (google-antigravity.ts): extends `OAuthCredentials` with `idToken`

## Logging
N/A

## CRUD Entry Points
- **Create**: Add a new provider file implementing `OAuthProviderInterface`, register in `index.ts`
- **Read**: Import OAuth providers via `@mariozechner/pi-ai` or directly from this directory
- **Update**: Modify OAuth flow implementations
- **Delete**: Remove provider file and registration from `index.ts`

## Style Guide
- One OAuth provider per file
- Provider functions named `login<Provider>(callbacks)` and `refresh<Provider>Token(credentials)`
- Local HTTP callback servers for browser-based flows (unique ports per provider)
- Base64-encoded client IDs/secrets decoded at runtime
- PKCE used for all browser-based flows

```typescript
const provider: OAuthProviderInterface = {
	id: "provider-name",
	name: "Provider Display Name",
	login: async (callbacks) => { /* ... */ },
	refresh: async (credentials) => { /* ... */ },
};
```
