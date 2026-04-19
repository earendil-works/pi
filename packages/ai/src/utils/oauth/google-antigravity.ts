/**
 * Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * Uses different OAuth credentials than google-gemini-cli for access to additional models.
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

type AntigravityCredentials = OAuthCredentials & {
	projectId: string;
};

const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";

let _createServer: typeof import("node:http").createServer | null = null;
let _httpImportPromise: Promise<void> | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	_httpImportPromise = import("node:http").then((m) => {
		_createServer = m.createServer;
	});
}

// Antigravity OAuth credentials (different from Gemini CLI)
const decode = (s: string) => atob(s);
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

type CallbackServerInfo = {
	server: Server;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

/**
 * Start a local HTTP server to receive the OAuth callback
 */
async function getNodeCreateServer(): Promise<typeof import("node:http").createServer> {
	if (_createServer) return _createServer;
	if (_httpImportPromise) {
		await _httpImportPromise;
	}
	if (_createServer) return _createServer;
	throw new Error("Antigravity OAuth is only available in Node.js environments");
}

async function startCallbackServer(): Promise<CallbackServerInfo> {
	const createServer = await getNodeCreateServer();

	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			const url = new URL(req.url || "", `http://localhost:51121`);

			if (url.pathname === "/oauth-callback") {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Google authentication did not complete.", `Error: ${error}`));
					return;
				}

				if (code && state) {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthSuccessHtml("Google authentication completed. You can close this window."));
					settleWait?.({ code, state });
				} else {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
				}
			} else {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(51121, CALLBACK_HOST, () => {
			resolve({
				server,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

/**
 * Parse redirect URL to extract code and state
 */
function parseRedirectUrl(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL, return empty
		return {};
	}
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
 * @param onManualCodeInput - Optional promise that resolves with user-pasted redirect URL.
 *                            Races with browser callback - whichever completes first wins.
 */
export async function loginAntigravity(
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
	onManualCodeInput?: () => Promise<string>,
): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	// Start local server for callback
	onProgress?.("Starting local server for OAuth callback...");
	const server = await startCallbackServer();

	let code: string | undefined;

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
			instructions: "Complete the sign-in in your browser.",
		});

		// Wait for the callback, racing with manual input if provided
		onProgress?.("Waiting for OAuth callback...");

		if (onManualCodeInput) {
			// Race between browser callback and manual input
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			// If manual input was cancelled, throw that error
			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				// Browser callback won - verify state
				if (result.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = result.code;
			} else if (manualInput) {
				// Manual input won
				const parsed = parseRedirectUrl(manualInput);
				if (parsed.state && parsed.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = parsed.code;
			}

			// If still no code, wait for manual promise and try that
			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					const parsed = parseRedirectUrl(manualInput);
					if (parsed.state && parsed.state !== verifier) {
						throw new Error("OAuth state mismatch - possible CSRF attack");
					}
					code = parsed.code;
				}
			}
		} else {
			// Original flow: just wait for callback
			const result = await server.waitForCode();
			if (result?.code) {
				if (result.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = result.code;
			}
		}

		if (!code) {
			throw new Error("No authorization code received");
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

		const credentials: OAuthCredentials = {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
			projectId,
			email,
		};

		return credentials;
	} finally {
		server.server.close();
	}
}

export const antigravityOAuthProvider: OAuthProviderInterface = {
	id: "google-antigravity",
	name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAntigravity(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as AntigravityCredentials;
		if (!creds.projectId) {
			throw new Error("Antigravity credentials missing projectId");
		}
		return refreshAntigravityToken(creds.refresh, creds.projectId);
	},

	getApiKey(credentials: OAuthCredentials): string {
		const creds = credentials as AntigravityCredentials;
		return JSON.stringify({ token: creds.access, projectId: creds.projectId });
	},
};
