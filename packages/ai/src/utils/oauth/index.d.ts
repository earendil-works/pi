/**
 * OAuth credential management for AI providers.
 *
 * This module handles login, token refresh, and credential storage
 * for OAuth-based providers:
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 * - Google Cloud Code Assist (Gemini CLI)
 * - Antigravity (Gemini 3, Claude, GPT-OSS via Google Cloud)
 */
export { loginAnthropic, refreshAnthropicToken } from "./anthropic.js";
export {
	enableAllGitHubCopilotModels,
	enableGitHubCopilotModel,
	getBaseUrlFromToken,
	getGitHubCopilotBaseUrl,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.js";
export { type AntigravityCredentials, loginAntigravity, refreshAntigravityToken } from "./google-antigravity.js";
export { type GoogleCloudCredentials, loginGeminiCli, refreshGoogleCloudToken } from "./google-gemini-cli.js";
export { loginOpenAICodex, refreshOpenAICodexToken } from "./openai-codex.js";
export {
	addOAuthAccount,
	clearOAuthAccountCooldown,
	getActiveOAuthAccount,
	getNextAvailableOAuthAccount,
	getOAuthPath,
	hasOAuthCredentials,
	listOAuthAccounts,
	listOAuthProviders,
	loadOAuthCredentials,
	loadOAuthStorage,
	markOAuthAccountCooldown,
	type OAuthAccountEntry,
	type OAuthCredentials,
	type OAuthMultiAccountStorage,
	type OAuthProvider,
	type OAuthStorage,
	type OAuthStorageBackend,
	type OAuthStorageEntry,
	removeOAuthAccount,
	removeOAuthCredentials,
	resetOAuthStorage,
	saveOAuthCredentials,
	setActiveOAuthAccount,
	setOAuthStorage,
	updateOAuthAccountCredentials,
} from "./storage.js";
import type { OAuthProvider } from "./storage.js";
/**
 * Refresh token for any OAuth provider.
 * Saves the new credentials and returns the new access token.
 */
export declare function refreshToken(provider: OAuthProvider): Promise<string>;
/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * For google-gemini-cli and antigravity, returns JSON-encoded { token, projectId }
 *
 * @returns API key string, or null if no credentials
 */
export declare function getOAuthApiKey(provider: OAuthProvider): Promise<string | null>;
/**
 * Map model provider to OAuth provider.
 * Returns undefined if the provider doesn't use OAuth.
 */
export declare function getOAuthProviderForModelProvider(modelProvider: string): OAuthProvider | undefined;
export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};
export type OAuthAuthInfo = {
	url: string;
	instructions?: string;
};
export interface OAuthProviderInfo {
	id: OAuthProvider;
	name: string;
	available: boolean;
}
/**
 * Get list of OAuth providers
 */
export declare function getOAuthProviders(): OAuthProviderInfo[];
//# sourceMappingURL=index.d.ts.map
