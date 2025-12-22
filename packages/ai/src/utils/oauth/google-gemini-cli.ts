/**
 * Gemini CLI OAuth flow (Google Cloud Code Assist)
 * Standard Gemini models only (gemini-2.0-flash, gemini-2.5-*)
 */

import { createHash, randomBytes } from "crypto";
import { createServer, type Server } from "http";
import { type OAuthCredentials, saveOAuthCredentials } from "./storage.js";

const decode = (s: string) => Buffer.from(s, "base64").toString();
const CLIENT_ID = decode(
	"NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const CLIENT_SECRET = decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

export interface GoogleCloudCredentials extends OAuthCredentials {
	projectId: string;
	email?: string;
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
 * Start a local HTTP server to receive the OAuth callback
 */
function startCallbackServer(): Promise<{ server: Server; getCode: () => Promise<{ code: string; state: string }> }> {
	return new Promise((resolve, reject) => {
		let codeResolve: (value: { code: string; state: string }) => void;
		let codeReject: (error: Error) => void;

		const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
			codeResolve = res;
			codeReject = rej;
		});

		const server = createServer((req, res) => {
			const url = new URL(req.url || "", `http://localhost:8085`);

			if (url.pathname === "/oauth2callback") {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Authentication Failed</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`,
					);
					codeReject(new Error(`OAuth error: ${error}`));
					return;
				}

				if (code && state) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Authentication Successful</h1><p>You can close this window and return to the terminal.</p></body></html>`,
					);
					codeResolve({ code, state });
				} else {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Authentication Failed</h1><p>Missing code or state parameter.</p></body></html>`,
					);
					codeReject(new Error("Missing code or state in callback"));
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(8085, "127.0.0.1", () => {
			resolve({
				server,
				getCode: () => codePromise,
			});
		});
	});
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface OnboardUserPayload {
	done?: boolean;
	response?: {
		cloudaicompanionProject?: { id?: string };
	};
}

/**
 * Wait helper for onboarding retries
 */
function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get default tier ID from allowed tiers
 */
function getDefaultTierId(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): string | undefined {
	if (!allowedTiers || allowedTiers.length === 0) return undefined;
	const defaultTier = allowedTiers.find((t) => t.isDefault);
	return defaultTier?.id ?? allowedTiers[0]?.id;
}

/**
 * Discover or provision a Google Cloud project for the user
 */
async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	// Try to load existing project via loadCodeAssist
	onProgress?.("Checking for existing Cloud Code Assist project...");
	const loadResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			},
		}),
	});

	if (loadResponse.ok) {
		const data = (await loadResponse.json()) as LoadCodeAssistPayload;

		// If we have an existing project, use it
		if (data.cloudaicompanionProject) {
			return data.cloudaicompanionProject;
		}

		// Otherwise, try to onboard with the FREE tier
		const tierId = getDefaultTierId(data.allowedTiers) ?? "FREE";

		onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");

		// Onboard with retries (the API may take time to provision)
		for (let attempt = 0; attempt < 10; attempt++) {
			const onboardResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					tierId,
					metadata: {
						ideType: "IDE_UNSPECIFIED",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
					},
				}),
			});

			if (onboardResponse.ok) {
				const onboardData = (await onboardResponse.json()) as OnboardUserPayload;
				const projectId = onboardData.response?.cloudaicompanionProject?.id;

				if (onboardData.done && projectId) {
					return projectId;
				}
			}

			// Wait before retrying
			if (attempt < 9) {
				onProgress?.(`Waiting for project provisioning (attempt ${attempt + 2}/10)...`);
				await wait(3000);
			}
		}
	}

	throw new Error(
		"Could not discover or provision a Google Cloud project. " +
			"Please ensure you have access to Google Cloud Code Assist (Gemini CLI).",
	);
}

/**
 * Get user email from the access token
 */
async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// Ignore errors, email is optional
	}
	return undefined;
}

/**
 * Refresh Google Cloud Code Assist token
 */
export async function refreshGoogleCloudToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Google Cloud token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		type: "oauth",
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}

/**
 * Login with Gemini CLI (Google Cloud Code Assist) OAuth
 *
 * @param onAuth - Callback with URL and optional instructions
 * @param onProgress - Optional progress callback
 */
export async function loginGeminiCli(
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
): Promise<GoogleCloudCredentials> {
	const { verifier, challenge } = generatePKCE();

	// Start local server for callback
	onProgress?.("Starting local server for OAuth callback...");
	const { server, getCode } = await startCallbackServer();

	try {
		// Build authorization URL
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});

		const authUrl = `${AUTH_URL}?${authParams.toString()}`;

		// Notify caller with URL to open
		onAuth({
			url: authUrl,
			instructions: "Complete the sign-in in your browser. The callback will be captured automatically.",
		});

		// Wait for the callback
		onProgress?.("Waiting for OAuth callback...");
		const { code, state } = await getCode();

		// Verify state matches
		if (state !== verifier) {
			throw new Error("OAuth state mismatch - possible CSRF attack");
		}

		// Exchange code for tokens
		onProgress?.("Exchanging authorization code for tokens...");
		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				code,
				grant_type: "authorization_code",
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

		if (!tokenData.refresh_token) {
			throw new Error("No refresh token received. Please try again.");
		}

		// Get user email
		onProgress?.("Getting user info...");
		const email = await getUserEmail(tokenData.access_token);

		// Discover project
		const projectId = await discoverProject(tokenData.access_token, onProgress);

		// Calculate expiry time (current time + expires_in seconds - 5 min buffer)
		const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

		const credentials: GoogleCloudCredentials = {
			type: "oauth",
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
			projectId,
			email,
		};

		saveOAuthCredentials("google-gemini-cli", credentials);

		return credentials;
	} finally {
		server.close();
	}
}
