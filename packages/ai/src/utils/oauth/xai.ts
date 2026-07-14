/**
 * xAI OAuth flow for SuperGrok and eligible X Premium subscriptions.
 * CLI-only: browser login uses a local HTTP callback server.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthAuth } from "../../auth/types.ts";
import { getProviderEnvValue } from "../provider-env.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type {
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProviderInterface,
} from "./types.ts";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_VERIFICATION_URI = "https://accounts.x.ai/oauth2/device";
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = "openid profile email offline_access grok-cli:access api:access";
const EXPIRY_SKEW_MS = 2 * 60 * 1000;
export const XAI_BROWSER_LOGIN_METHOD = "browser";
export const XAI_DEVICE_CODE_LOGIN_METHOD = "device_code";

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
};

type CallbackServer = {
	server?: Server;
	cancelWait: () => void;
	waitForCode: () => Promise<string | null>;
};

function callbackHost(): string {
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		// Not a URL.
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

async function readTokenResponse(
	response: Response,
	operation: string,
	previousRefresh?: string,
): Promise<OAuthCredentials> {
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`xAI OAuth token ${operation} failed (${response.status}): ${body || response.statusText}`);
	}
	let data: TokenResponse;
	try {
		data = JSON.parse(body) as TokenResponse;
	} catch {
		throw new Error(`xAI OAuth token ${operation} returned invalid JSON`);
	}
	if (!data.access_token || typeof data.expires_in !== "number" || (!data.refresh_token && !previousRefresh)) {
		throw new Error(`xAI OAuth token ${operation} response missing fields`);
	}
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? previousRefresh ?? "",
		expires: Date.now() + data.expires_in * 1000 - EXPIRY_SKEW_MS,
	};
}

async function postToken(body: URLSearchParams, operation: string, signal?: AbortSignal, previousRefresh?: string) {
	let response: Response;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body,
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw error;
	}
	return readTokenResponse(response, operation, previousRefresh);
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
	let settle: ((code: string | null) => void) | undefined;
	const codePromise = new Promise<string | null>((resolve) => {
		let settled = false;
		settle = (code) => {
			if (settled) return;
			settled = true;
			resolve(code);
		};
	});
	const server = createServer((req, res) => {
		const url = new URL(req.url || "", "http://localhost");
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthErrorHtml("Callback route not found."));
			return;
		}
		if (url.searchParams.get("state") !== expectedState) {
			res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthErrorHtml("State mismatch."));
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				oauthErrorHtml(
					"xAI authentication did not complete.",
					url.searchParams.get("error_description") ?? undefined,
				),
			);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(oauthSuccessHtml("xAI authentication completed. You can close this window."));
		settle?.(code);
	});
	return new Promise((resolve) => {
		server.listen(CALLBACK_PORT, callbackHost(), () =>
			resolve({ server, cancelWait: () => settle?.(null), waitForCode: () => codePromise }),
		);
		server.on("error", () => resolve({ cancelWait: () => settle?.(null), waitForCode: async () => null }));
	});
}

export async function loginXai(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onManualCodeInput?: () => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = randomBytes(16).toString("hex");
	const server = await startCallbackServer(state);
	const url = new URL(AUTHORIZE_URL);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		nonce: randomBytes(16).toString("hex"),
	}).toString();
	options.onAuth({
		url: url.toString(),
		instructions: "Complete login in your browser. If it is on another machine, paste the final redirect URL here.",
	});

	let code: string | undefined;
	try {
		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: unknown;
			const manualPromise = options.onManualCodeInput().then(
				(input) => {
					manualInput = input;
					server.cancelWait();
				},
				(error) => {
					manualError = error;
					server.cancelWait();
				},
			);
			const callbackCode = await server.waitForCode();
			if (manualError) throw manualError;
			if (callbackCode) {
				code = callbackCode;
			} else if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
				code = parsed.code;
			}
			if (!code) {
				await manualPromise;
				if (manualError) throw manualError;
				const parsed = parseAuthorizationInput(manualInput ?? "");
				if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
				code = parsed.code;
			}
		} else {
			code = (await server.waitForCode()) ?? undefined;
		}
		if (!code) {
			const parsed = parseAuthorizationInput(
				await options.onPrompt({
					message: "Paste the authorization code or full redirect URL:",
					placeholder: REDIRECT_URI,
				}),
			);
			if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
			code = parsed.code;
		}
		if (!code) throw new Error("Missing authorization code");
		options.onProgress?.("Exchanging authorization code for tokens...");
		return postToken(
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				client_id: CLIENT_ID,
				code_verifier: verifier,
			}),
			"exchange",
			options.signal,
		);
	} finally {
		server.server?.close();
	}
}

export async function loginXaiDeviceCode(options: {
	onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const response = await fetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }),
		signal: options.signal,
	});
	const body = await response.text();
	if (!response.ok)
		throw new Error(`xAI device authorization failed (${response.status}): ${body || response.statusText}`);
	const data = JSON.parse(body) as {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		verification_uri_complete?: string;
		expires_in?: number;
		interval?: number;
	};
	if (!data.device_code || !data.user_code || typeof data.expires_in !== "number") {
		throw new Error("xAI device authorization response missing fields");
	}
	options.onDeviceCode({
		userCode: data.user_code,
		verificationUri: data.verification_uri_complete ?? data.verification_uri ?? DEVICE_VERIFICATION_URI,
		intervalSeconds: data.interval,
		expiresInSeconds: data.expires_in,
	});
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds: data.interval,
		expiresInSeconds: data.expires_in,
		waitBeforeFirstPoll: true,
		signal: options.signal,
		poll: async () => {
			const tokenResponse = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: data.device_code ?? "",
					client_id: CLIENT_ID,
				}),
				signal: options.signal,
			});
			if (tokenResponse.ok) return { status: "complete", value: await readTokenResponse(tokenResponse, "exchange") };
			const errorBody = await tokenResponse.text();
			let errorCode: string | undefined;
			try {
				errorCode = (JSON.parse(errorBody) as { error?: string }).error;
			} catch {}
			if (errorCode === "authorization_pending") return { status: "pending" };
			if (errorCode === "slow_down") return { status: "slow_down" };
			return {
				status: "failed",
				message: `xAI device authorization failed (${tokenResponse.status}): ${errorBody || tokenResponse.statusText}`,
			};
		},
	});
}

export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
	return postToken(
		new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
		"refresh",
		undefined,
		refreshToken,
	);
}

async function selectLoginMethod(
	prompt: (message: string, options: Array<{ id: string; label: string }>) => Promise<string | undefined>,
) {
	return prompt("Select xAI login method:", [
		{ id: XAI_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
		{ id: XAI_DEVICE_CODE_LOGIN_METHOD, label: "Device code login (headless)" },
	]);
}

export const xaiOAuth: OAuthAuth = {
	name: "xAI (SuperGrok/X Premium)",
	async login(callbacks) {
		const method = await selectLoginMethod(async (message, options) =>
			callbacks.prompt({ type: "select", message, options }),
		);
		if (method === XAI_DEVICE_CODE_LOGIN_METHOD) {
			return {
				...(await loginXaiDeviceCode({
					onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
					signal: callbacks.signal,
				})),
				type: "oauth",
			};
		}
		if (method !== XAI_BROWSER_LOGIN_METHOD)
			throw new Error(method ? `Unknown xAI login method: ${method}` : "Login cancelled");
		const manualAbort = new AbortController();
		try {
			return {
				...(await loginXai({
					onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
					onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
					onManualCodeInput: () =>
						callbacks.prompt({
							type: "manual_code",
							message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
							placeholder: REDIRECT_URI,
							signal: manualAbort.signal,
						}),
					onProgress: (message) => callbacks.notify({ type: "progress", message }),
					signal: callbacks.signal,
				})),
				type: "oauth",
			};
		} finally {
			manualAbort.abort();
		}
	},
	async refresh(credential) {
		return { ...(await refreshXaiToken(credential.refresh)), type: "oauth" };
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (SuperGrok/X Premium)",
	usesCallbackServer: true,
	async login(callbacks: OAuthLoginCallbacks) {
		const method = await selectLoginMethod((message, options) => callbacks.onSelect({ message, options }));
		if (!method) throw new Error("Login cancelled");
		if (method === XAI_DEVICE_CODE_LOGIN_METHOD)
			return loginXaiDeviceCode({ onDeviceCode: callbacks.onDeviceCode, signal: callbacks.signal });
		if (method !== XAI_BROWSER_LOGIN_METHOD) throw new Error(`Unknown xAI login method: ${method}`);
		return loginXai({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onManualCodeInput: callbacks.onManualCodeInput,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},
	refreshToken(credentials) {
		return refreshXaiToken(credentials.refresh);
	},
	getApiKey(credentials) {
		return credentials.access;
	},
};
