/**
 * Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * Uses different OAuth credentials than google-gemini-cli for access to additional models.
 */

import { createHash, randomBytes } from "crypto";
import { createServer, type Server } from "http";
import { type OAuthCredentials, saveOAuthCredentials } from "./storage.js";

// Antigravity OAuth credentials (different from Gemini CLI)
const decode = (s: string) => Buffer.from(s, "base64").toString();
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const REDIRECT_URI = "http://localhost:51121/oauth-callback";

// Antigravity requires additional scopes
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Fallback project ID when discovery fails
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

export interface AntigravityCredentials extends OAuthCredentials {
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
			const url = new URL(req.url || "", `http://localhost:51121`);

			if (url.pathname === "/oauth-callback") {
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

		server.listen(51121, "127.0.0.1", () => {
			resolve({
				server,
				getCode: () => codePromise,
			});
		});
	});
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

/**
 * Discover or provision a project for the user
 */
async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		}),
	};

	// Try endpoints in order: prod first, then sandbox
	const endpoints = ["https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.sandbox.googleapis.com"];

	onProgress?.("Checking for existing project...");

	for (const endpoint of endpoints) {
		try {
			const loadResponse = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
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

				// Handle both string and object formats
				if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
					return data.cloudaicompanionProject;
				}
				if (
					data.cloudaicompanionProject &&
					typeof data.cloudaicompanionProject === "object" &&
					data.cloudaicompanionProject.id
				) {
					return data.cloudaicompanionProject.id;
				}
			}
		} catch {
			// Try next endpoint
		}
	}

	// Use fallback project ID
	onProgress?.("Using default project...");
	return DEFAULT_PROJECT_ID;
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
 * Refresh Antigravity token
 */
export async function refreshAntigravityToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
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
		throw new Error(`Antigravity token refresh failed: ${error}`);
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
 * Login with Antigravity OAuth
 *
 * @param onAuth - Callback with URL and optional instructions
 * @param onProgress - Optional progress callback
 */
export async function loginAntigravity(
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
): Promise<AntigravityCredentials> {
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

		const credentials: AntigravityCredentials = {
			type: "oauth",
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
			projectId,
			email,
		};

		saveOAuthCredentials("google-antigravity", credentials);

		return credentials;
	} finally {
		server.close();
	}
}
