import { loginAnthropic, refreshAnthropicToken } from "./anthropic.js";
import { loginGoogleCloud, refreshGoogleCloudToken } from "./google-cloud.js";
import {
	listOAuthProviders as listOAuthProvidersFromStorage,
	loadOAuthCredentials,
	type OAuthCredentials,
	removeOAuthCredentials,
	saveOAuthCredentials,
} from "./storage.js";

// Re-export for convenience
export { listOAuthProvidersFromStorage as listOAuthProviders };

export type SupportedOAuthProvider = "anthropic" | "github-copilot" | "google-cloud-code-assist";

export interface OAuthProviderInfo {
	id: SupportedOAuthProvider;
	name: string;
	available: boolean;
}

export interface PromptRequest {
	message: string;
	kind?: "text" | "secret";
	placeholder?: string;
}

export type OnPrompt = (req: PromptRequest) => Promise<string>;

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
			id: "google-cloud-code-assist",
			name: "Google Cloud Code Assist",
			available: true,
		},
		{
			id: "github-copilot",
			name: "GitHub Copilot (coming soon)",
			available: false,
		},
	];
}

/**
 * Login with OAuth provider
 */
export async function login(
	provider: SupportedOAuthProvider,
	onAuth: (info: { url: string; instructions?: string }) => void,
	onPromptCode: () => Promise<string>,
	onProgress?: (message: string) => void,
): Promise<void> {
	switch (provider) {
		case "anthropic":
			await loginAnthropic((url) => onAuth({ url }), onPromptCode);
			break;
		case "google-cloud-code-assist":
			await loginGoogleCloud(onAuth, onProgress);
			break;
		case "github-copilot":
			throw new Error("GitHub Copilot OAuth is not yet implemented");
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}
}

/**
 * Logout from OAuth provider
 */
export async function logout(provider: SupportedOAuthProvider): Promise<void> {
	removeOAuthCredentials(provider);
}

/**
 * Refresh OAuth token for provider
 */
export async function refreshToken(provider: SupportedOAuthProvider): Promise<string> {
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}

	let newCredentials: OAuthCredentials;

	switch (provider) {
		case "anthropic":
			newCredentials = await refreshAnthropicToken(credentials.refresh);
			break;
		case "google-cloud-code-assist":
			newCredentials = await refreshGoogleCloudToken(credentials.refresh, credentials.projectId);
			break;
		case "github-copilot":
			throw new Error("GitHub Copilot OAuth is not yet implemented");
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}

	// Save new credentials
	saveOAuthCredentials(provider, newCredentials);

	return newCredentials.access;
}

/**
 * Get OAuth token for provider (auto-refreshes if expired)
 */
export async function getOAuthToken(provider: SupportedOAuthProvider): Promise<string | null> {
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		return null;
	}

	// Check if token is expired (with 5 min buffer already applied)
	if (Date.now() >= credentials.expires) {
		// Token expired - refresh it
		try {
			return await refreshToken(provider);
		} catch (error) {
			console.error(`Failed to refresh OAuth token for ${provider}:`, error);
			// Remove invalid credentials
			removeOAuthCredentials(provider);
			return null;
		}
	}

	return credentials.access;
}
