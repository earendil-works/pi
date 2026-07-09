/**
 * xAI Grok OAuth flow (SuperGrok subscription)
 *
 * Device-code login against auth.x.ai. Uses the public Grok CLI client id.
 * Inference goes through https://api.x.ai/v1 with the access token as a Bearer key.
 */

import type { OAuthAuth } from "../../auth/types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_ISSUER = "https://auth.x.ai";
const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`;
const XAI_DEVICE_CODE_URL = `${XAI_ISSUER}/oauth2/device/code`;
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";

type JsonObject = Record<string, unknown>;

type XaiDiscovery = {
	authorization_endpoint: string;
	token_endpoint: string;
};

type XaiDeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval: number;
};

type XaiTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
	token_type?: string;
	error?: string;
	error_description?: string;
};

async function readJsonResponse(response: Response): Promise<JsonObject> {
	const text = await response.text();
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("response was not a JSON object");
		}
		return parsed as JsonObject;
	} catch (error) {
		throw new Error(`Invalid JSON response (${response.status}): ${text || String(error)}`);
	}
}

function validateXaiEndpoint(rawUrl: unknown, field: string): string {
	if (typeof rawUrl !== "string" || !rawUrl.trim()) {
		throw new Error(`xAI discovery response is missing ${field}`);
	}
	const url = new URL(rawUrl);
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error(`Refusing non-xAI OAuth endpoint for ${field}: ${rawUrl}`);
	}
	return url.toString();
}

async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<JsonObject> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields).toString(),
		signal,
	});
	const payload = await readJsonResponse(response);
	if (!response.ok) {
		const message =
			(typeof payload.error_description === "string" && payload.error_description) ||
			(typeof payload.error === "string" && payload.error) ||
			JSON.stringify(payload);
		if (response.status === 403) {
			throw new Error(
				`xAI OAuth was rejected with HTTP 403: ${message}. SuperGrok API access may require a standalone SuperGrok tier; X Premium+ alone may not include this API path.`,
			);
		}
		throw new Error(`xAI OAuth request failed with HTTP ${response.status}: ${message}`);
	}
	return payload;
}

async function discoverXai(signal?: AbortSignal): Promise<XaiDiscovery> {
	const response = await fetch(XAI_DISCOVERY_URL, {
		headers: { Accept: "application/json" },
		signal,
	});
	if (!response.ok) {
		throw new Error(`xAI OIDC discovery failed with HTTP ${response.status}`);
	}
	const payload = await readJsonResponse(response);
	return {
		authorization_endpoint: validateXaiEndpoint(payload.authorization_endpoint, "authorization_endpoint"),
		token_endpoint: validateXaiEndpoint(payload.token_endpoint, "token_endpoint"),
	};
}

async function requestDeviceCode(signal?: AbortSignal): Promise<XaiDeviceCodeResponse> {
	const payload = await postForm(
		XAI_DEVICE_CODE_URL,
		{
			client_id: XAI_CLIENT_ID,
			scope: XAI_SCOPE,
		},
		signal,
	);
	const required = ["device_code", "user_code", "verification_uri", "expires_in", "interval"] as const;
	for (const key of required) {
		if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
			throw new Error(`xAI device-code response missing ${key}`);
		}
	}
	return {
		device_code: String(payload.device_code),
		user_code: String(payload.user_code),
		verification_uri: String(payload.verification_uri),
		verification_uri_complete:
			typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete : undefined,
		expires_in: Number(payload.expires_in),
		interval: Number(payload.interval),
	};
}

function jwtExpiryMs(accessToken: string): number | undefined {
	try {
		const [, payloadPart] = accessToken.split(".");
		if (!payloadPart) return undefined;
		const padded = payloadPart.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
		const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: unknown };
		if (typeof payload.exp !== "number") return undefined;
		return payload.exp * 1000;
	} catch {
		return undefined;
	}
}

function credentialsFromTokenPayload(payload: XaiTokenResponse, previousRefresh?: string): OAuthCredentials {
	const access = String(payload.access_token || "").trim();
	const refresh = String(payload.refresh_token || previousRefresh || "").trim();
	if (!access) throw new Error("xAI token response was missing access_token");
	if (!refresh) throw new Error("xAI token response was missing refresh_token");

	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in || 0);
	const skewSeconds = expiresIn > 0 ? Math.min(300, Math.max(60, Math.floor(expiresIn / 3))) : 120;
	const expires =
		expiresIn > 0
			? Date.now() + Math.max(0, expiresIn - skewSeconds) * 1000
			: (jwtExpiryMs(access) || Date.now() + 10 * 60 * 1000) - 120 * 1000;

	return { access, refresh, expires };
}

/**
 * Login with xAI Grok OAuth using device-code flow.
 */
export async function loginXaiOAuth(options: {
	onDeviceCode: OAuthLoginCallbacks["onDeviceCode"];
	onAuth?: OAuthLoginCallbacks["onAuth"];
	onProgress?: OAuthLoginCallbacks["onProgress"];
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	options.onProgress?.("Discovering xAI OAuth endpoints...");
	const discovery = await discoverXai(options.signal);
	options.onProgress?.("Requesting device code...");
	const device = await requestDeviceCode(options.signal);
	const verificationUrl = device.verification_uri_complete || device.verification_uri;

	options.onDeviceCode({
		userCode: device.user_code,
		verificationUri: verificationUrl,
		intervalSeconds: Math.max(1, device.interval),
		expiresInSeconds: Math.max(1, device.expires_in),
	});
	options.onAuth?.({
		url: verificationUrl,
		instructions: "Approve the device code in your browser to finish xAI Grok OAuth login.",
	});

	const tokenPayload = await pollOAuthDeviceCodeFlow<XaiTokenResponse>({
		intervalSeconds: Math.max(1, device.interval),
		expiresInSeconds: Math.max(1, device.expires_in),
		signal: options.signal,
		poll: async () => {
			const response = await fetch(discovery.token_endpoint, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: XAI_CLIENT_ID,
					device_code: device.device_code,
				}).toString(),
				signal: options.signal,
			});
			const payload = (await readJsonResponse(response)) as XaiTokenResponse;
			if (response.ok) {
				if (!payload.access_token || !payload.refresh_token) {
					return {
						status: "failed",
						message: "xAI token response did not include access_token and refresh_token",
					};
				}
				return { status: "complete", value: payload };
			}
			const errorCode = String(payload.error || "");
			if (errorCode === "authorization_pending") {
				return { status: "pending" };
			}
			if (errorCode === "slow_down") {
				return { status: "slow_down" };
			}
			return {
				status: "failed",
				message: `xAI device-code polling failed: ${payload.error_description || payload.error || response.status}`,
			};
		},
	});

	return credentialsFromTokenPayload(tokenPayload);
}

/**
 * Refresh xAI Grok OAuth token.
 */
export async function refreshXaiOAuthToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	const discovery = await discoverXai(signal);
	const payload = await postForm(
		discovery.token_endpoint,
		{
			grant_type: "refresh_token",
			client_id: XAI_CLIENT_ID,
			refresh_token: refreshToken,
		},
		signal,
	);
	return credentialsFromTokenPayload(payload as XaiTokenResponse, refreshToken);
}

export const xaiOAuth: OAuthAuth = {
	name: "xAI Grok OAuth (SuperGrok)",

	async login(callbacks) {
		const credentials = await loginXaiOAuth({
			onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
			onAuth: (info) => callbacks.notify({ type: "auth_url", url: info.url, instructions: info.instructions }),
			onProgress: (message) => callbacks.notify({ type: "progress", message }),
			signal: callbacks.signal,
		});
		return { ...credentials, type: "oauth" };
	},

	async refresh(credential) {
		return { ...(await refreshXaiOAuthToken(credential.refresh)), type: "oauth" };
	},

	async toAuth(credential) {
		return { apiKey: credential.access, baseUrl: XAI_BASE_URL };
	},
};

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai-oauth",
	name: "xAI Grok OAuth (SuperGrok)",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXaiOAuth({
			onDeviceCode: callbacks.onDeviceCode,
			onAuth: callbacks.onAuth,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXaiOAuthToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};

