/**
 * xAI Grok account OAuth flow.
 *
 * This uses xAI's OIDC device-code flow for Grok account subscriptions.
 */

import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type { OAuthCredentials, OAuthDeviceCodeInfo, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const ISSUER = "https://auth.x.ai";
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type OidcEndpoints = {
	tokenEndpoint: string;
	deviceAuthorizationEndpoint: string;
};

type DeviceCodeResponse = {
	device_code?: unknown;
	user_code?: unknown;
	verification_uri?: unknown;
	verification_uri_complete?: unknown;
	interval?: unknown;
	expires_in?: unknown;
};

type TokenResponse = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	error?: unknown;
	error_description?: unknown;
};

type DeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
};

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function resolveClientId(): string {
	if (typeof process !== "undefined" && process.env.XAI_GROK_CLIENT_ID) {
		return process.env.XAI_GROK_CLIENT_ID;
	}
	return DEFAULT_CLIENT_ID;
}

function normalizeHttpsUrl(value: string, field: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Untrusted ${field} in xAI Grok OAuth response`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`Untrusted ${field} in xAI Grok OAuth response`);
	}
	return url.href;
}

async function readJsonObject(response: Response, operation: string): Promise<Record<string, unknown>> {
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		throw new Error(`xAI Grok OAuth ${operation} returned invalid JSON: ${text}`);
	}
	if (!body || typeof body !== "object") {
		throw new Error(`xAI Grok OAuth ${operation} returned invalid response`);
	}
	return body as Record<string, unknown>;
}

async function fetchForm(url: string, body: URLSearchParams, signal?: AbortSignal): Promise<Response> {
	try {
		return await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}
}

export async function discoverXaiGrokOidcEndpoints(
	issuer: string = ISSUER,
	signal?: AbortSignal,
): Promise<OidcEndpoints> {
	const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
	const response = await fetch(discoveryUrl, { signal });
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`xAI Grok OIDC discovery failed (${response.status}): ${text || response.statusText}`);
	}

	const body = await readJsonObject(response, "discovery");
	const tokenEndpoint = asString(body.token_endpoint);
	const deviceAuthorizationEndpoint = asString(body.device_authorization_endpoint);
	if (!tokenEndpoint || !deviceAuthorizationEndpoint) {
		throw new Error("xAI Grok OIDC discovery response is missing required endpoints");
	}

	return {
		tokenEndpoint: normalizeHttpsUrl(tokenEndpoint, "token_endpoint"),
		deviceAuthorizationEndpoint: normalizeHttpsUrl(deviceAuthorizationEndpoint, "device_authorization_endpoint"),
	};
}

async function startDeviceCodeFlow(
	endpoints: OidcEndpoints,
	clientId: string,
	signal?: AbortSignal,
): Promise<DeviceCode> {
	const response = await fetchForm(
		endpoints.deviceAuthorizationEndpoint,
		new URLSearchParams({
			client_id: clientId,
			scope: SCOPE,
		}),
		signal,
	);

	const body = (await readJsonObject(response, "device authorization")) as DeviceCodeResponse;
	if (!response.ok) {
		throw new Error(
			`xAI Grok device-code request failed (${response.status}): ${JSON.stringify(body) || response.statusText}`,
		);
	}

	const deviceCode = asString(body.device_code);
	const userCode = asString(body.user_code);
	const verificationUri = asString(body.verification_uri_complete) ?? asString(body.verification_uri);
	const expiresIn = asNumber(body.expires_in);
	const interval = body.interval === undefined ? undefined : asNumber(body.interval);
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!expiresIn ||
		(interval === undefined && body.interval !== undefined)
	) {
		throw new Error(`Invalid xAI Grok device-code response: ${JSON.stringify(body)}`);
	}

	return {
		deviceCode,
		userCode,
		verificationUri: normalizeHttpsUrl(verificationUri, "verification_uri"),
		expiresInSeconds: expiresIn,
		intervalSeconds: interval,
	};
}

function credentialsFromToken(
	token: TokenResponse,
	clientId: string,
	issuer: string,
	source: string,
	fallbackRefreshToken?: string,
): OAuthCredentials {
	const access = asString(token.access_token);
	const refresh = asString(token.refresh_token) ?? fallbackRefreshToken;
	if (!access) {
		throw new Error("xAI Grok token response did not return access_token");
	}
	if (!refresh) {
		throw new Error("xAI Grok token response did not return refresh_token");
	}

	const expiresIn = asNumber(token.expires_in) ?? 3600;
	return {
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000,
		oidcIssuer: issuer,
		oidcClientId: clientId,
		source,
	};
}

async function pollForToken(
	endpoints: OidcEndpoints,
	device: DeviceCode,
	clientId: string,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	return pollOAuthDeviceCodeFlow<TokenResponse>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal,
		poll: async () => {
			const response = await fetchForm(
				endpoints.tokenEndpoint,
				new URLSearchParams({
					grant_type: DEVICE_CODE_GRANT_TYPE,
					device_code: device.deviceCode,
					client_id: clientId,
				}),
				signal,
			);
			const body = (await readJsonObject(response, "device token")) as TokenResponse;

			if (response.ok && asString(body.access_token)) {
				return { status: "complete", value: body };
			}

			const error = asString(body.error);
			if (error === "authorization_pending") {
				return { status: "pending" };
			}
			if (error === "slow_down") {
				return { status: "slow_down" };
			}

			const description = asString(body.error_description);
			return {
				status: "failed",
				message: `xAI Grok device authorization failed (${response.status}): ${error ?? response.statusText}${
					description ? `: ${description}` : ""
				}`,
			};
		},
	});
}

export async function loginXaiGrokDeviceCode(options: {
	onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const clientId = resolveClientId();
	const endpoints = await discoverXaiGrokOidcEndpoints(ISSUER, options.signal);
	const device = await startDeviceCodeFlow(endpoints, clientId, options.signal);
	options.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});

	const token = await pollForToken(endpoints, device, clientId, options.signal);
	return credentialsFromToken(token, clientId, ISSUER, "xai-grok-device-code");
}

export async function refreshXaiGrokToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const issuer = asString(credentials.oidcIssuer) ?? ISSUER;
	const clientId = asString(credentials.oidcClientId) ?? resolveClientId();
	const endpoints = await discoverXaiGrokOidcEndpoints(issuer);
	const response = await fetchForm(
		endpoints.tokenEndpoint,
		new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: clientId,
		}),
	);
	const body = (await readJsonObject(response, "token refresh")) as TokenResponse;
	if (!response.ok) {
		throw new Error(
			`xAI Grok token refresh failed (${response.status}): ${JSON.stringify(body) || response.statusText}`,
		);
	}

	return credentialsFromToken(body, clientId, issuer, "xai-grok-refresh-token", credentials.refresh);
}

export const xaiGrokOAuthProvider: OAuthProviderInterface = {
	id: "xai-grok",
	name: "xAI Grok Account",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXaiGrokDeviceCode({
			onDeviceCode: callbacks.onDeviceCode,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXaiGrokToken(credentials);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
