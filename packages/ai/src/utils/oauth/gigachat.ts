/**
 * GigaChat login flow.
 *
 * The @mariozechner/pi-ai/oauth entry point is named historically.
 * GigaChat itself uses an authorization-key exchange that returns a short-lived
 * access token instead of a browser OAuth flow.
 */

import GigaChat, { type GigaChatClientConfig } from "gigachat";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

type GigaChatScope = "GIGACHAT_API_PERS" | "GIGACHAT_API_B2B" | "GIGACHAT_API_CORP";

type GigaChatCredentials = OAuthCredentials & {
	authorizationKey: string;
	scope: GigaChatScope;
};

const GIGACHAT_CERTIFICATES_URL = "https://developers.sber.ru/docs/ru/gigachat/certificates";
const DEFAULT_SCOPE: GigaChatScope = "GIGACHAT_API_PERS";
const EXPIRY_BUFFER_MS = 60 * 1000;
const VALID_SCOPES = new Set<GigaChatScope>(["GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"]);

function normalizeAuthorizationKey(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("GigaChat authorization key is required");
	}
	return trimmed.replace(/^Basic\s+/i, "");
}

function normalizeScope(input: string): GigaChatScope {
	const trimmed = input.trim();
	if (!trimmed) {
		return DEFAULT_SCOPE;
	}

	const scope = trimmed.toUpperCase() as GigaChatScope;
	if (!VALID_SCOPES.has(scope)) {
		throw new Error(
			`Invalid GigaChat scope: ${trimmed}. Use GIGACHAT_API_PERS, GIGACHAT_API_B2B, or GIGACHAT_API_CORP.`,
		);
	}

	return scope;
}

function parseExpiresAt(expiresAt: unknown): number {
	let expiresAtNumber: number | undefined;
	if (typeof expiresAt === "number") {
		expiresAtNumber = expiresAt;
	} else if (typeof expiresAt === "string" && expiresAt.trim()) {
		expiresAtNumber = Number(expiresAt);
	}

	if (expiresAtNumber === undefined || !Number.isFinite(expiresAtNumber)) {
		throw new Error("Invalid GigaChat token response: missing expires_at");
	}

	const normalizedExpiresAtNumber: number = expiresAtNumber;
	const expiresAtMs = normalizedExpiresAtNumber > 1e12 ? normalizedExpiresAtNumber : normalizedExpiresAtNumber * 1000;
	return Math.max(Date.now(), expiresAtMs - EXPIRY_BUFFER_MS);
}

function withCertificateHint(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (!message.toLowerCase().includes("certificate")) {
		return error instanceof Error ? error : new Error(message);
	}

	return new Error(
		`${message}. GigaChat token exchange may require the Russian Trusted Root CA. See ${GIGACHAT_CERTIFICATES_URL}`,
	);
}

class PiGigaChatClient extends GigaChat {
	get accessTokenData(): { access_token?: unknown; expires_at?: unknown } | undefined {
		return this._accessToken;
	}
}

function createClient(authorizationKey: string, scope: GigaChatScope): PiGigaChatClient {
	const config = {
		credentials: authorizationKey,
		scope,
	} satisfies GigaChatClientConfig;

	return new PiGigaChatClient(config);
}

async function updateToken(client: PiGigaChatClient): Promise<void> {
	const originalConsoleInfo = console.info;
	console.info = () => {};
	try {
		await client.updateToken();
	} finally {
		console.info = originalConsoleInfo;
	}
}

async function requestAccessToken(
	authorizationKey: string,
	scope: GigaChatScope,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const normalizedAuthorizationKey = normalizeAuthorizationKey(authorizationKey);
	const client = createClient(normalizedAuthorizationKey, scope);

	try {
		await updateToken(client);
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw withCertificateHint(error);
	}

	if (signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const data = client.accessTokenData;

	if (!data || typeof data.access_token !== "string" || data.access_token.length === 0) {
		throw new Error("Invalid GigaChat token response: missing access_token");
	}

	return {
		access: data.access_token,
		refresh: normalizedAuthorizationKey,
		expires: parseExpiresAt(data.expires_at),
		authorizationKey: normalizedAuthorizationKey,
		scope,
	};
}

export async function refreshGigaChatToken(
	authorizationKey: string,
	scope: GigaChatScope = DEFAULT_SCOPE,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	return requestAccessToken(authorizationKey, scope, signal);
}

export async function loginGigaChat(options: {
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const rawAuthorizationKey = await options.onPrompt({
		message: "GigaChat authorization key",
		placeholder: "Basic <base64 client_id:client_secret>",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const rawScope = await options.onPrompt({
		message: "GigaChat scope (blank for GIGACHAT_API_PERS)",
		placeholder: DEFAULT_SCOPE,
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const authorizationKey = normalizeAuthorizationKey(rawAuthorizationKey);
	const scope = normalizeScope(rawScope);

	options.onProgress?.("Requesting GigaChat access token...");
	return requestAccessToken(authorizationKey, scope, options.signal);
}

export const gigachatOAuthProvider: OAuthProviderInterface = {
	id: "gigachat",
	name: "GigaChat",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGigaChat({
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const gigachatCredentials = credentials as Partial<GigaChatCredentials>;
		const authorizationKey =
			typeof gigachatCredentials.authorizationKey === "string" && gigachatCredentials.authorizationKey.length > 0
				? gigachatCredentials.authorizationKey
				: gigachatCredentials.refresh;

		if (typeof authorizationKey !== "string" || authorizationKey.length === 0) {
			throw new Error("GigaChat credentials missing authorization key");
		}

		const scope = normalizeScope(
			typeof gigachatCredentials.scope === "string" ? gigachatCredentials.scope : DEFAULT_SCOPE,
		);
		return refreshGigaChatToken(authorizationKey, scope);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
