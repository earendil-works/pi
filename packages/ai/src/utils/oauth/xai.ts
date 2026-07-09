/**
 * xAI OAuth device-code flow.
 *
 * Uses the public Grok CLI client registration selected for this integration.
 * OAuth access tokens authenticate the existing https://api.x.ai/v1 provider.
 */

import type { OAuthAuth } from "../../auth/types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type { OAuthCredentials, OAuthDeviceCodeInfo, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const XAI_OAUTH_NAME = "xAI (Grok subscription)";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_DEVICE_CODE_LIFETIME_SECONDS = 60 * 60;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 31 * 24 * 60 * 60;
const MAX_POLL_INTERVAL_SECONDS = 5 * 60;
const MAX_TOKEN_LENGTH = 128 * 1024;
const MAX_DEVICE_CODE_LENGTH = 8 * 1024;
const MAX_USER_CODE_LENGTH = 128;
const MAX_VERIFICATION_URI_LENGTH = 4 * 1024;
const VERIFICATION_HOSTS = new Set(["accounts.x.ai", "auth.x.ai"]);

type JsonObject = Record<string, unknown>;

type OAuthHttpResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type OAuthFetchResponse = {
	response: Response;
	timeoutSignal: AbortSignal;
};

type XaiDeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
};

class XaiOAuthRequestTimeoutError extends Error {}
class XaiOAuthResponseError extends Error {}

function requiredString(body: JsonObject, field: string, maxLength: number): string {
	const value = body[field];
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		value !== value.trim() ||
		/[\u0000-\u001f\u007f]/.test(value)
	) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function positiveInteger(body: JsonObject, field: string, maximum: number): number {
	const value = body[field];
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value as number;
}

function optionalPositiveInteger(body: JsonObject, field: string, maximum: number): number | undefined {
	if (body[field] === undefined) return undefined;
	return positiveInteger(body, field, maximum);
}

function validateVerificationUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}

	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== "" ||
		!VERIFICATION_HOSTS.has(url.hostname.toLowerCase())
	) {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}

	return url.href;
}

async function readJsonObject(response: Response): Promise<JsonObject> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const declaredBytes = Number(contentLength);
		if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_RESPONSE_BYTES) {
			throw new XaiOAuthResponseError("xAI OAuth response exceeded the size limit");
		}
	}

	if (!response.body) {
		throw new XaiOAuthResponseError("xAI OAuth returned an empty response");
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			totalBytes += result.value.byteLength;
			if (totalBytes > MAX_RESPONSE_BYTES) {
				try {
					await reader.cancel();
				} catch {
					// Keep the security error stable even if stream cancellation fails.
				}
				throw new XaiOAuthResponseError("xAI OAuth response exceeded the size limit");
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	let parsed: unknown;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		parsed = JSON.parse(text);
	} catch {
		throw new XaiOAuthResponseError("xAI OAuth returned invalid JSON");
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new XaiOAuthResponseError("xAI OAuth returned an invalid response");
	}
	return parsed as JsonObject;
}

async function fetchOAuth(url: string, init: RequestInit, signal?: AbortSignal): Promise<OAuthFetchResponse> {
	const timeoutSignal = AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	try {
		return {
			response: await fetch(url, {
				...init,
				credentials: "omit",
				redirect: "error",
				referrerPolicy: "no-referrer",
				signal: requestSignal,
			}),
			timeoutSignal,
		};
	} catch {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		if (timeoutSignal.aborted) {
			throw new XaiOAuthRequestTimeoutError("xAI OAuth request timed out");
		}
		throw new Error("xAI OAuth request failed");
	}
}

async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<OAuthHttpResponse> {
	const { response, timeoutSignal } = await fetchOAuth(
		url,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
		},
		signal,
	);
	let body: JsonObject;
	try {
		body = await readJsonObject(response);
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		if (timeoutSignal.aborted) {
			throw new XaiOAuthRequestTimeoutError("xAI OAuth request timed out");
		}
		if (error instanceof XaiOAuthResponseError) {
			throw error;
		}
		throw new Error("xAI OAuth response failed");
	}
	return {
		ok: response.ok,
		status: response.status,
		body,
	};
}

function safeErrorCode(body: JsonObject): string | undefined {
	const error = body.error;
	return typeof error === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(error) ? error : undefined;
}

function requestFailure(action: string, response: OAuthHttpResponse): Error {
	const code = safeErrorCode(response.body);
	const suffix = code ? `, ${code}` : "";
	return new Error(`xAI OAuth ${action} failed (HTTP ${response.status}${suffix})`);
}

function parseDeviceCode(body: JsonObject): XaiDeviceCode {
	const verificationUri = requiredString(body, "verification_uri", MAX_VERIFICATION_URI_LENGTH);
	return {
		deviceCode: requiredString(body, "device_code", MAX_DEVICE_CODE_LENGTH),
		userCode: requiredString(body, "user_code", MAX_USER_CODE_LENGTH),
		verificationUri: validateVerificationUri(verificationUri),
		intervalSeconds: optionalPositiveInteger(body, "interval", MAX_POLL_INTERVAL_SECONDS),
		expiresInSeconds: positiveInteger(body, "expires_in", MAX_DEVICE_CODE_LIFETIME_SECONDS),
	};
}

function credentialsFromTokenResponse(body: JsonObject, previousRefreshToken?: string): OAuthCredentials {
	const access = requiredString(body, "access_token", MAX_TOKEN_LENGTH);
	const refresh =
		body.refresh_token === undefined && previousRefreshToken
			? previousRefreshToken
			: requiredString(body, "refresh_token", MAX_TOKEN_LENGTH);
	const expiresInSeconds = positiveInteger(body, "expires_in", MAX_ACCESS_TOKEN_LIFETIME_SECONDS);
	const tokenType = body.token_type;
	if (tokenType !== undefined && (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer")) {
		throw new Error("Invalid xAI OAuth response field: token_type");
	}

	const lifetimeMs = expiresInSeconds * 1000;
	const refreshSkewMs = Math.min(5 * 60_000, Math.max(1000, Math.floor(lifetimeMs / 10)), lifetimeMs / 2);
	return {
		access,
		refresh,
		expires: Date.now() + lifetimeMs - refreshSkewMs,
	};
}

async function requestDeviceCode(signal?: AbortSignal): Promise<XaiDeviceCode> {
	const response = await postForm(
		XAI_DEVICE_CODE_URL,
		{
			client_id: XAI_CLIENT_ID,
			scope: XAI_SCOPE,
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("device authorization", response);
	}
	return parseDeviceCode(response.body);
}

async function pollForTokens(device: XaiDeviceCode, signal?: AbortSignal): Promise<OAuthCredentials> {
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			let response: OAuthHttpResponse;
			try {
				response = await postForm(
					XAI_TOKEN_URL,
					{
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						client_id: XAI_CLIENT_ID,
						device_code: device.deviceCode,
					},
					signal,
				);
			} catch (error) {
				if (error instanceof XaiOAuthRequestTimeoutError) {
					return { status: "backoff" };
				}
				throw error;
			}

			if (response.ok) {
				return { status: "complete", value: credentialsFromTokenResponse(response.body) };
			}

			const error = safeErrorCode(response.body);
			if (error === "authorization_pending") {
				return { status: "pending" };
			}
			if (error === "slow_down") {
				return {
					status: "slow_down",
					intervalSeconds: optionalPositiveInteger(response.body, "interval", MAX_POLL_INTERVAL_SECONDS),
				};
			}
			if (error === "access_denied" || error === "authorization_denied") {
				return { status: "failed", message: "xAI device authorization was denied" };
			}
			if (error === "expired_token") {
				return { status: "failed", message: "xAI device code expired" };
			}
			return { status: "failed", message: requestFailure("device authorization", response).message };
		},
	});
}

export async function loginXaiOAuth(options: {
	onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const device = await requestDeviceCode(options.signal);
	options.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForTokens(device, options.signal);
}

export async function refreshXaiOAuthToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	const response = await postForm(
		XAI_TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: XAI_CLIENT_ID,
			refresh_token: refreshToken,
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("token refresh", response);
	}
	return credentialsFromTokenResponse(response.body, refreshToken);
}

export const xaiOAuth: OAuthAuth = {
	name: XAI_OAUTH_NAME,

	async login(callbacks) {
		const credentials = await loginXaiOAuth({
			onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
			signal: callbacks.signal,
		});
		return { ...credentials, type: "oauth" };
	},

	async refresh(credential) {
		return { ...(await refreshXaiOAuthToken(credential.refresh)), type: "oauth" };
	},

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXaiOAuth({
			onDeviceCode: callbacks.onDeviceCode,
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
