/**
 * OpenAI Codex (ChatGPT OAuth) flow
 *
 * NOTE: This module uses Node.js crypto and http for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
	import("node:http").then((m) => {
		_http = m;
	});
}

import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.ts";

const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_AUTH_BASE_URL = `${AUTH_BASE_URL}/api/accounts`;
const DEVICE_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEVICE_CODE_MAX_WAIT_MS = 15 * 60 * 1000; // 15 minutes

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed"; message: string; status?: number };
type TokenResult = TokenSuccess | TokenFailure;

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

function createState(): string {
	if (!_randomBytes) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	return _randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function decodeJwt(token: string): JwtPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = atob(payload);
		return JSON.parse(decoded) as JwtPayload;
	} catch {
		return null;
	}
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		return {
			type: "failed",
			status: response.status,
			message: `OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`,
		};
	}

	const json = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		return {
			type: "failed",
			message: `OpenAI Codex token exchange response missing fields: ${JSON.stringify(json)}`,
		};
	}

	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				type: "failed",
				status: response.status,
				message: `OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`,
			};
		}

		const json = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};

		if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
			return {
				type: "failed",
				message: `OpenAI Codex token refresh response missing fields: ${JSON.stringify(json)}`,
			};
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: Date.now() + json.expires_in * 1000,
		};
	} catch (error) {
		return {
			type: "failed",
			message: `OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function createAuthorizationFlow(
	originator: string = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", originator);

	return { verifier, state, url: url.toString() };
}

type OAuthServerInfo = {
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
};

function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
	if (!_http) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}

	let settleWait: ((value: { code: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = _http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== "/auth/callback") {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthSuccessHtml("OpenAI authentication completed. You can close this window."));
			settleWait?.({ code });
		} catch {
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthErrorHtml("Internal error while processing OAuth callback."));
		}
	});

	return new Promise((resolve) => {
		server
			.listen(1455, CALLBACK_HOST, () => {
				resolve({
					close: () => server.close(),
					cancelWait: () => {
						settleWait?.(null);
					},
					waitForCode: () => waitForCodePromise,
				});
			})
			.on("error", (_err: NodeJS.ErrnoException) => {
				settleWait?.(null);
				resolve({
					close: () => {
						try {
							server.close();
						} catch {
							// ignore
						}
					},
					cancelWait: () => {},
					waitForCode: async () => null,
				});
			});
	});
}

// ============================================================================
// Device Code Flow (headless / SSH-friendly)
// ============================================================================

type DeviceCodeUserCodeResponse = {
	device_auth_id: string;
	user_code: string;
	interval: string | number;
};

type DeviceCodeTokenResponse = {
	authorization_code: string;
	code_challenge: string;
	code_verifier: string;
};

/**
 * Request a device code from OpenAI's device auth endpoint.
 * Returns null if the endpoint is not available (404).
 */
async function requestDeviceCode(): Promise<{
	deviceAuthId: string;
	userCode: string;
	interval: number;
} | null> {
	const url = `${DEVICE_AUTH_BASE_URL}/deviceauth/usercode`;
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
	});

	if (response.status === 404) {
		// Device code login not enabled for this client
		return null;
	}

	if (!response.ok) {
		throw new Error(`Device code request failed with status ${response.status}`);
	}

	const data = (await response.json()) as DeviceCodeUserCodeResponse;
	const interval = typeof data.interval === "string" ? Number.parseInt(data.interval, 10) : data.interval;

	return {
		deviceAuthId: data.device_auth_id,
		userCode: data.user_code,
		interval: Number.isNaN(interval) ? 5 : interval,
	};
}

/**
 * Poll the device auth token endpoint until the user completes login
 * or the timeout is reached.
 */
async function pollDeviceCodeToken(
	deviceAuthId: string,
	userCode: string,
	intervalSeconds: number,
	signal?: AbortSignal,
): Promise<DeviceCodeTokenResponse> {
	const url = `${DEVICE_AUTH_BASE_URL}/deviceauth/token`;
	const deadline = Date.now() + DEVICE_CODE_MAX_WAIT_MS;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				device_auth_id: deviceAuthId,
				user_code: userCode,
			}),
		});

		if (response.ok) {
			return (await response.json()) as DeviceCodeTokenResponse;
		}

		// 403 = authorization_pending, 404 = not yet authorized - keep polling
		if (response.status === 403 || response.status === 404) {
			const remaining = deadline - Date.now();
			const sleepMs = Math.min(intervalSeconds * 1000, remaining);
			if (sleepMs <= 0) break;
			await abortableSleep(sleepMs, signal);
			continue;
		}

		throw new Error(`Device auth polling failed with status ${response.status}`);
	}

	throw new Error("Device code login timed out after 15 minutes");
}

/**
 * Sleep that can be interrupted by an AbortSignal.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

/**
 * Login with OpenAI Codex using the device code flow.
 * No local server or browser redirect needed - works over SSH.
 *
 * Flow:
 * 1. Request a one-time user code from OpenAI
 * 2. User visits verification URL and enters the code
 * 3. Poll until the user completes login
 * 4. Exchange the returned authorization code for tokens
 */
export async function loginOpenAICodexDeviceCode(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	onWaiting?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const deviceCode = await requestDeviceCode();
	if (!deviceCode) {
		throw new Error("Device code login is not available for this client");
	}

	options.onAuth({
		url: DEVICE_VERIFICATION_URL,
		instructions: `Enter code: ${deviceCode.userCode}`,
	});

	options.onWaiting?.("Waiting for you to complete login in your browser...");

	const tokenResponse = await pollDeviceCodeToken(
		deviceCode.deviceAuthId,
		deviceCode.userCode,
		deviceCode.interval,
		options.signal,
	);

	options.onProgress?.("Exchanging authorization code for tokens...");

	// The device code flow returns server-generated PKCE values
	const tokenResult = await exchangeAuthorizationCode(
		tokenResponse.authorization_code,
		tokenResponse.code_verifier,
		DEVICE_REDIRECT_URI,
	);

	if (tokenResult.type !== "success") {
		throw new Error("Token exchange failed");
	}

	const accountId = getAccountId(tokenResult.access);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return {
		access: tokenResult.access,
		refresh: tokenResult.refresh,
		expires: tokenResult.expires,
		accountId,
	};
}

function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * Login with OpenAI Codex OAuth
 *
 * @param options.onAuth - Called with URL and instructions when auth starts
 * @param options.onPrompt - Called to prompt user for manual code paste (fallback if no onManualCodeInput)
 * @param options.onProgress - Optional progress messages
 * @param options.onManualCodeInput - Optional promise that resolves with user-pasted code.
 *                                    Races with browser callback - whichever completes first wins.
 *                                    Useful for showing paste input immediately alongside browser flow.
 * @param options.originator - OAuth originator parameter (defaults to "pi")
 */
export async function loginOpenAICodex(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	originator?: string;
}): Promise<OAuthCredentials> {
	const { verifier, state, url } = await createAuthorizationFlow(options.originator);
	const server = await startLocalOAuthServer(state);

	options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });

	let code: string | undefined;
	try {
		if (options.onManualCodeInput) {
			// Race between browser callback and manual input
			let manualCode: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualCode = input;
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
				// Browser callback won
				code = result.code;
			} else if (manualCode) {
				// Manual input won (or callback timed out and user had entered code)
				const parsed = parseAuthorizationInput(manualCode);
				if (parsed.state && parsed.state !== state) {
					throw new Error("State mismatch");
				}
				code = parsed.code;
			}

			// If still no code, wait for manual promise to complete and try that
			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualCode) {
					const parsed = parseAuthorizationInput(manualCode);
					if (parsed.state && parsed.state !== state) {
						throw new Error("State mismatch");
					}
					code = parsed.code;
				}
			}
		} else {
			// Original flow: wait for callback, then prompt if needed
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
			}
		}

		// Fallback to onPrompt if still no code
		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code (or full redirect URL):",
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== state) {
				throw new Error("State mismatch");
			}
			code = parsed.code;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		const tokenResult = await exchangeAuthorizationCode(code, verifier);
		if (tokenResult.type !== "success") {
			throw new Error(tokenResult.message);
		}

		const accountId = getAccountId(tokenResult.access);
		if (!accountId) {
			throw new Error("Failed to extract accountId from token");
		}

		return {
			access: tokenResult.access,
			refresh: tokenResult.refresh,
			expires: tokenResult.expires,
			accountId,
		};
	} finally {
		server.close();
	}
}

/**
 * Refresh OpenAI Codex OAuth token
 */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const result = await refreshAccessToken(refreshToken);
	if (result.type !== "success") {
		throw new Error(result.message);
	}

	const accountId = getAccountId(result.access);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return {
		access: result.access,
		refresh: result.refresh,
		expires: result.expires,
		accountId,
	};
}

export const openaiCodexOAuthProvider: OAuthProviderInterface = {
	id: "openai-codex",
	name: "ChatGPT Plus/Pro (Codex Subscription)",
	loginOptionLabel: "Browser login (default)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginOpenAICodex({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshOpenAICodexToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};

export const openaiCodexDeviceCodeOAuthProvider: OAuthProviderInterface = {
	id: "openai-codex-device-code",
	name: "ChatGPT Plus/Pro (Codex Subscription) - Device Code (for remote flows)",
	credentialsProviderId: "openai-codex",
	parentProviderId: "openai-codex",
	loginOptionLabel: "Device Code (for remote flows)",
	usesCallbackServer: false,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginOpenAICodexDeviceCode({
			onAuth: callbacks.onAuth,
			onProgress: callbacks.onProgress,
			onWaiting: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshOpenAICodexToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
