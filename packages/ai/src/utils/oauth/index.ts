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

// Anthropic
export { loginAnthropic, refreshAnthropicToken } from "./anthropic.js";
// GitHub Copilot
export {
	enableAllGitHubCopilotModels,
	enableGitHubCopilotModel,
	getBaseUrlFromToken,
	getGitHubCopilotBaseUrl,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.js";
// Google Antigravity
export {
	type AntigravityCredentials,
	loginAntigravity,
	refreshAntigravityToken,
} from "./google-antigravity.js";
// Google Gemini CLI
export {
	type GoogleCloudCredentials,
	loginGeminiCli,
	refreshGoogleCloudToken,
} from "./google-gemini-cli.js";
// Storage
export {
	getOAuthPath,
	hasOAuthCredentials,
	listOAuthProviders,
	loadOAuthCredentials,
	loadOAuthStorage,
	type OAuthCredentials,
	type OAuthProvider,
	type OAuthStorage,
	type OAuthStorageBackend,
	removeOAuthCredentials,
	resetOAuthStorage,
	saveOAuthCredentials,
	setOAuthStorage,
} from "./storage.js";

// ============================================================================
// High-level API
// ============================================================================

import { refreshAnthropicToken } from "./anthropic.js";
import { refreshGitHubCopilotToken } from "./github-copilot.js";
import { refreshAntigravityToken } from "./google-antigravity.js";
import { refreshGoogleCloudToken } from "./google-gemini-cli.js";
import type { OAuthCredentials, OAuthProvider } from "./storage.js";
import { loadOAuthCredentials, removeOAuthCredentials, saveOAuthCredentials } from "./storage.js";

/**
 * Refresh token for any OAuth provider.
 * Saves the new credentials and returns the new access token.
 */
export async function refreshToken(provider: OAuthProvider): Promise<string> {
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}

	let newCredentials: OAuthCredentials;

	switch (provider) {
		case "anthropic":
			newCredentials = await refreshAnthropicToken(credentials.refresh);
			break;
		case "github-copilot":
			newCredentials = await refreshGitHubCopilotToken(credentials.refresh, credentials.enterpriseUrl);
			break;
		case "google-gemini-cli":
			if (!credentials.projectId) {
				throw new Error("Google Cloud credentials missing projectId");
			}
			newCredentials = await refreshGoogleCloudToken(credentials.refresh, credentials.projectId);
			break;
		case "google-antigravity":
			if (!credentials.projectId) {
				throw new Error("Antigravity credentials missing projectId");
			}
			newCredentials = await refreshAntigravityToken(credentials.refresh, credentials.projectId);
			break;
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}

	saveOAuthCredentials(provider, newCredentials);
	return newCredentials.access;
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * For google-gemini-cli and antigravity, returns JSON-encoded { token, projectId }
 *
 * @returns API key string, or null if no credentials
 */
export async function getOAuthApiKey(provider: OAuthProvider): Promise<string | null> {
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		return null;
	}

	// Providers that need projectId in the API key
	const needsProjectId = provider === "google-gemini-cli" || provider === "google-antigravity";

	// Check if expired
	if (Date.now() >= credentials.expires) {
		try {
			const newToken = await refreshToken(provider);

			// For providers that need projectId, return JSON
			if (needsProjectId) {
				const refreshedCreds = loadOAuthCredentials(provider);
				if (refreshedCreds?.projectId) {
					return JSON.stringify({ token: newToken, projectId: refreshedCreds.projectId });
				}
			}

			return newToken;
		} catch (error) {
			console.error(`Failed to refresh OAuth token for ${provider}:`, error);
			removeOAuthCredentials(provider);
			return null;
		}
	}

	// For providers that need projectId, return JSON
	if (needsProjectId) {
		if (!credentials.projectId) {
			return null;
		}
		return JSON.stringify({ token: credentials.access, projectId: credentials.projectId });
	}

	return credentials.access;
}

/**
 * Map model provider to OAuth provider.
 * Returns undefined if the provider doesn't use OAuth.
 */
export function getOAuthProviderForModelProvider(modelProvider: string): OAuthProvider | undefined {
	const mapping: Record<string, OAuthProvider> = {
		anthropic: "anthropic",
		"github-copilot": "github-copilot",
		"google-gemini-cli": "google-gemini-cli",
		"google-antigravity": "google-antigravity",
	};
	return mapping[modelProvider];
}

// ============================================================================
// Login/Logout types for convenience
// ============================================================================

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
export function getOAuthProviders(): OAuthProviderInfo[] {
	return [
		{
			id: "anthropic",
			name: "Anthropic (Claude Pro/Max)",
			available: true,
		},
		{
			id: "github-copilot",
			name: "GitHub Copilot",
			available: true,
		},
		{
			id: "google-gemini-cli",
			name: "Google Cloud Code Assist (Gemini CLI)",
			available: true,
		},
		{
			id: "google-antigravity",
			name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
			available: true,
		},
	];
}
