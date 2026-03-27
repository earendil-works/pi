/**
 * OpenAI Codex (ChatGPT OAuth) device + callback flow
 */

import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed" };
type TokenResult = TokenSuccess | TokenFailure;

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

type DeviceCodeResponse = {
	device_auth_id: string;
	user_code: string;
	interval: number;
};

type DeviceTokenSuccess = {
	authorization_code: string;
	code_challenge: string;
	code_verifier: string;
};

type OAuthServerInfo = {
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
};

type NodeApis = {
	randomBytes: typeof import("node:crypto").randomBytes;
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
		}

		nodeApisPromise = Promise.all([import("node:crypto"), import("node:http")]).then(
			([cryptoModule, httpModule]) => ({
				randomBytes: cryptoModule.randomBytes,
				createServer: httpModule.createServer,
			}),
		);
	}

	nodeApis = await nodeApisPromise;
	return nodeApis;
}

async function createState(): Promise<string> {
	if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	const { randomBytes } = await getNodeApis();
	return randomBytes(16).toString("hex");
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
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		return JSON.parse(decoded) as JwtPayload;
	} catch {
		return null;
	}
}

function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function isCloudflareBlockedDeviceFlowError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes("403") && (message.includes("<!doctype html") || message.includes("just a moment"));
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return promise;
	}

	if (signal.aborted) {
		onAbort?.();
		throw new Error("Login cancelled");
	}

	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			onAbort?.();
			reject(new Error("Login cancelled"));
		};

		signal.addEventListener("abort", abort, { once: true });

		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

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

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
	const data = await fetchJson(DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ client_id: CLIENT_ID }),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const deviceAuthId = (data as Record<string, unknown>).device_auth_id;
	const userCode = (data as Record<string, unknown>).user_code;
	const interval = (data as Record<string, unknown>).interval;
	const normalizedInterval =
		typeof interval === "string"
			? Number.parseInt(interval, 10)
			: typeof interval === "number"
				? interval
				: Number.NaN;

	if (typeof deviceAuthId !== "string" || typeof userCode !== "string" || !Number.isFinite(normalizedInterval)) {
		throw new Error("Invalid device code response fields");
	}

	return {
		device_auth_id: deviceAuthId,
		user_code: userCode,
		interval: normalizedInterval,
	};
}

async function createAuthorizationFlow(
	originator: string = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
	const { verifier, challenge } = await generatePKCE();
	const state = await createState();

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

function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
	return getNodeApis().then(
		({ createServer }) =>
			new Promise((resolve) => {
				let settleWait: ((value: { code: string } | null) => void) | undefined;
				const waitForCodePromise = new Promise<{ code: string } | null>((resolveWait) => {
					let settled = false;
					settleWait = (value) => {
						if (settled) return;
						settled = true;
						resolveWait(value);
					};
				});

				const server = createServer((req, res) => {
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

				server
					.listen(1455, "127.0.0.1", () => {
						resolve({
							close: () => server.close(),
							cancelWait: () => {
								settleWait?.(null);
							},
							waitForCode: () => waitForCodePromise,
						});
					})
					.on("error", (err: NodeJS.ErrnoException) => {
						console.error(
							"[openai-codex] Failed to bind http://127.0.0.1:1455 (",
							err.code,
							") Falling back to manual paste.",
						);
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
			}),
	);
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
		console.error("[openai-codex] code->token failed:", response.status, text);
		return { type: "failed" };
	}

	const json = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		console.error("[openai-codex] token response missing fields:", json);
		return { type: "failed" };
	}

	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

async function pollForToken(
	deviceAuthId: string,
	userCode: string,
	intervalSeconds: number,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const deadline = Date.now() + DEVICE_FLOW_TIMEOUT_MS;
	const intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		await abortableSleep(Math.min(intervalMs, deadline - Date.now()), signal);

		const response = await fetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				device_auth_id: deviceAuthId,
				user_code: userCode,
			}),
		});

		if (response.ok) {
			const raw = (await response.json()) as unknown;
			if (!raw || typeof raw !== "object") {
				throw new Error("Invalid device token response");
			}

			const authorizationCode = (raw as DeviceTokenSuccess).authorization_code;
			const codeChallenge = (raw as DeviceTokenSuccess).code_challenge;
			const codeVerifier = (raw as DeviceTokenSuccess).code_verifier;

			if (
				typeof authorizationCode !== "string" ||
				typeof codeChallenge !== "string" ||
				typeof codeVerifier !== "string"
			) {
				throw new Error("Invalid device token response fields");
			}

			const tokenResult = await exchangeAuthorizationCode(authorizationCode, codeVerifier, DEVICE_REDIRECT_URI);
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

		if (response.status === 403 || response.status === 404) {
			continue;
		}

		const text = await response.text().catch(() => "");
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}

	throw new Error("Device flow timed out");
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
			console.error("[openai-codex] Token refresh failed:", response.status, text);
			return { type: "failed" };
		}

		const json = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};

		if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
			console.error("[openai-codex] Token refresh response missing fields:", json);
			return { type: "failed" };
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: Date.now() + json.expires_in * 1000,
		};
	} catch (error) {
		console.error("[openai-codex] Token refresh error:", error);
		return { type: "failed" };
	}
}

async function loginWithCallbackFlow(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onManualCodeInput?: () => Promise<string>;
	originator?: string;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const { verifier, state, url } = await createAuthorizationFlow(options.originator);
	const server = await startLocalOAuthServer(state);

	options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });

	let code: string | undefined;
	try {
		if (options.onManualCodeInput) {
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

			const result = await withAbortSignal(server.waitForCode(), options.signal, () => server.cancelWait());

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
			} else if (manualCode) {
				const parsed = parseAuthorizationInput(manualCode);
				if (parsed.state && parsed.state !== state) {
					throw new Error("State mismatch");
				}
				code = parsed.code;
			}

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
			const result = await withAbortSignal(server.waitForCode(), options.signal, () => server.cancelWait());
			if (result?.code) {
				code = result.code;
			}
		}

		if (!code) {
			const input = await withAbortSignal(
				options.onPrompt({
					message: "Paste the authorization code (or full redirect URL):",
				}),
				options.signal,
				() => server.cancelWait(),
			);
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
	} finally {
		server.close();
	}
}

export async function loginOpenAICodex(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	originator?: string;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const methodRaw = await withAbortSignal(
		options.onPrompt({
			message: "Login method for ChatGPT/Codex (headless/browser)",
			placeholder: "headless",
			allowEmpty: true,
		}),
		options.signal,
	);
	const method = methodRaw.trim().toLowerCase();
	const normalizedMethod = method === "headless" ? "device" : method === "browser" ? "callback" : method;

	if (normalizedMethod !== "" && normalizedMethod !== "device" && normalizedMethod !== "callback") {
		throw new Error(`Invalid login method: ${methodRaw}. Expected headless or browser.`);
	}

	if (normalizedMethod === "" || normalizedMethod === "device") {
		let device: DeviceCodeResponse;
		try {
			device = await startDeviceFlow();
		} catch (error) {
			if (isCloudflareBlockedDeviceFlowError(error)) {
				options.onProgress?.("Headless login blocked; switching to browser login...");
				return loginWithCallbackFlow(options);
			}
			throw error;
		}
		options.onAuth({
			url: DEVICE_VERIFICATION_URL,
			instructions: `Enter code: ${device.user_code}`,
		});

		return pollForToken(device.device_auth_id, device.user_code, device.interval, options.signal);
	}

	return loginWithCallbackFlow(options);
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const result = await refreshAccessToken(refreshToken);
	if (result.type !== "success") {
		throw new Error("Failed to refresh OpenAI Codex token");
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
	authFlow: "mixed",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginOpenAICodex({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
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
