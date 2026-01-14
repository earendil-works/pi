import { createHash, randomBytes } from "crypto";
import { loadOAuthCredentials, type OAuthCredentials, saveOAuthCredentials } from "./storage.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const DEFAULT_SCOPES = ["user:inference"];

/**
 * Get scopes for Anthropic OAuth.
 * Uses scopes from existing credentials if available, otherwise defaults to user:inference.
 */
function getScopes(): string {
	const existing = loadOAuthCredentials("anthropic");
	if (existing?.scopes && existing.scopes.length > 0) {
		return existing.scopes.join(" ");
	}
	return DEFAULT_SCOPES.join(" ");
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

/**
 * Login with Anthropic OAuth (device code flow)
 */
export async function loginAnthropic(
	onAuthUrl: (url: string) => void,
	onPromptCode: () => Promise<string>,
): Promise<void> {
	const { verifier, challenge } = generatePKCE();
	const scopes = getScopes();

	// Build authorization URL
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: scopes,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

	// Notify caller with URL to open
	onAuthUrl(authUrl);

	// Wait for user to paste authorization code (format: code#state)
	const authCode = await onPromptCode();
	const splits = authCode.split("#");
	const code = splits[0];
	const state = splits[1];

	// Exchange code for tokens
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: code,
			state: state,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		throw new Error(`Token exchange failed: ${error}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	// Calculate expiry time (current time + expires_in seconds - 5 min buffer)
	const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

	// Save credentials
	const credentials: OAuthCredentials = {
		type: "oauth",
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: expiresAt,
	};

	saveOAuthCredentials("anthropic", credentials);
}

/**
 * Refresh Anthropic OAuth token using refresh token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		throw new Error(`Token refresh failed: ${error}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	// Calculate expiry time (current time + expires_in seconds - 5 min buffer)
	const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

	return {
		type: "oauth",
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: expiresAt,
	};
}
