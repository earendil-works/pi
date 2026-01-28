/**
 * OAuth management for coding-agent.
 * Re-exports from @kennyfrc/mu-ai and adds convenience wrappers.
 */

import {
	getActiveOAuthAccount,
	getOAuthApiKey,
	listOAuthAccounts,
	listOAuthProviders as listOAuthProvidersFromAi,
	loadOAuthCredentials,
	loginAntigravity,
	loginGeminiCli,
	loginGitHubCopilot,
	loginOpenAICodex,
	type OAuthAccountEntry,
	type OAuthCredentials,
	type OAuthProvider,
	type OAuthStorageBackend,
	refreshToken as refreshTokenFromAi,
	removeOAuthAccount,
	removeOAuthCredentials,
	resetOAuthStorage,
	saveOAuthCredentials,
	setActiveOAuthAccount,
	setOAuthStorage,
} from "@kennyfrc/mu-ai";
import { loginAnthropic } from "./anthropic.js";

// Re-export types and functions
export type { OAuthAccountEntry, OAuthCredentials, OAuthProvider, OAuthStorageBackend };
export { listOAuthProvidersFromAi as listOAuthProviders };
export {
	getActiveOAuthAccount,
	getOAuthApiKey,
	listOAuthAccounts,
	loadOAuthCredentials,
	removeOAuthAccount,
	removeOAuthCredentials,
	resetOAuthStorage,
	saveOAuthCredentials,
	setActiveOAuthAccount,
	setOAuthStorage,
};

// Types for OAuth flow
export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}

export interface OAuthPrompt {
	message: string;
	placeholder?: string;
}

export type OAuthProviderInfo = {
	id: OAuthProvider;
	name: string;
	description: string;
	available: boolean;
};

export function getOAuthProviders(): OAuthProviderInfo[] {
	return [
		{
			id: "anthropic",
			name: "Anthropic (Claude Pro/Max)",
			description: "Use Claude with your Pro/Max subscription",
			available: true,
		},
		{
			id: "openai-codex",
			name: "ChatGPT Plus/Pro (Codex)",
			description: "Use GPT-5.x Codex models with your ChatGPT subscription",
			available: true,
		},
		{
			id: "github-copilot",
			name: "GitHub Copilot",
			description: "Use models via GitHub Copilot subscription",
			available: true,
		},
		{
			id: "google-gemini-cli",
			name: "Google Gemini CLI",
			description: "Free Gemini 2.0/2.5 models via Google Cloud",
			available: true,
		},
		{
			id: "google-antigravity",
			name: "Antigravity",
			description: "Free Gemini 3, Claude, GPT-OSS via Google Cloud",
			available: true,
		},
	];
}

/**
 * Login with OAuth provider
 */
export async function login(
	provider: OAuthProvider,
	onAuth: (info: OAuthAuthInfo) => void,
	onPrompt: (prompt: OAuthPrompt) => Promise<string>,
	onProgress?: (message: string) => void,
): Promise<void> {
	switch (provider) {
		case "anthropic":
			await loginAnthropic(
				(url) => onAuth({ url }),
				async () => onPrompt({ message: "Paste the authorization code below:" }),
			);
			break;
		case "openai-codex":
			await loginOpenAICodex({
				onAuth: (info) => onAuth({ url: info.url, instructions: info.instructions }),
				onPrompt,
				onProgress,
			});
			break;
		case "github-copilot": {
			const creds = await loginGitHubCopilot({
				onAuth: (url, instructions) => onAuth({ url, instructions }),
				onPrompt,
				onProgress,
			});
			saveOAuthCredentials("github-copilot", creds);
			break;
		}
		case "google-gemini-cli": {
			await loginGeminiCli((info) => onAuth({ url: info.url, instructions: info.instructions }), onProgress);
			break;
		}
		case "google-antigravity": {
			await loginAntigravity((info) => onAuth({ url: info.url, instructions: info.instructions }), onProgress);
			break;
		}
		default: {
			const _exhaustive: never = provider;
			throw new Error(`Unknown OAuth provider: ${_exhaustive}`);
		}
	}
}

/**
 * Logout from OAuth provider
 */
export async function logout(provider: OAuthProvider): Promise<void> {
	removeOAuthCredentials(provider);
}

/**
 * Refresh OAuth token for provider.
 * Delegates to the ai package implementation.
 */
export async function refreshToken(provider: OAuthProvider): Promise<string> {
	return refreshTokenFromAi(provider);
}

/**
 * Get OAuth token for provider (auto-refreshes if expired).
 */
export async function getOAuthToken(provider: OAuthProvider): Promise<string | null> {
	return getOAuthApiKey(provider);
}
