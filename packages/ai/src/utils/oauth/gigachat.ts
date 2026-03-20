/**
 * GigaChat login flow.
 *
 * The @mariozechner/pi-ai/oauth entry point is named historically.
 * GigaChat uses a short-lived access token instead of a browser OAuth flow.
 */

import GigaChat, { type GigaChatClientConfig } from "gigachat";
import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

type GigaChatScope = "GIGACHAT_API_PERS" | "GIGACHAT_API_B2B" | "GIGACHAT_API_CORP";
type GigaChatAuthMode = "basic" | "token";
type GigaChatStoredAuthMode = GigaChatAuthMode | "password";
type GigaChatAccountType = "personal" | "business";
type GigaChatBaseUrlChoice = "default" | "custom";

type GigaChatCredentials = OAuthCredentials & {
	authMode?: GigaChatStoredAuthMode;
	accountType?: GigaChatAccountType;
	authorizationKey?: string;
	scope?: GigaChatScope;
	baseUrl?: string;
	user?: string;
	password?: string;
};

const GIGACHAT_CERTIFICATES_URL = "https://developers.sber.ru/docs/ru/gigachat/certificates";
const DEFAULT_SCOPE: GigaChatScope = "GIGACHAT_API_PERS";
const DEFAULT_BUSINESS_SCOPE: GigaChatScope = "GIGACHAT_API_B2B";
const DEFAULT_BASE_URL = "https://gigachat.devices.sberbank.ru/api/v1";
const DEFAULT_AUTH_MODE: GigaChatAuthMode = "basic";
const EXPIRY_BUFFER_MS = 60 * 1000;
const VALID_SCOPES = new Set<GigaChatScope>(["GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"]);
const DEFAULT_BASE_URL_CHOICE = `Default (${DEFAULT_BASE_URL})`;
const CUSTOM_BASE_URL_CHOICE = "Custom";

function normalizeAuthorizationKey(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("GigaChat authorization key is required");
	}
	return trimmed.replace(/^Basic\s+/i, "");
}

function normalizePassword(input: string): string {
	if (!input.trim()) {
		throw new Error("GigaChat password is required");
	}
	return input;
}

function normalizeScope(input: string, fallbackScope: GigaChatScope = DEFAULT_SCOPE): GigaChatScope {
	const trimmed = input.trim();
	if (!trimmed) {
		return fallbackScope;
	}

	const scope = trimmed.toUpperCase() as GigaChatScope;
	if (!VALID_SCOPES.has(scope)) {
		const lower = trimmed.toLowerCase();
		if (["personal", "pers", "individual"].includes(lower)) {
			return "GIGACHAT_API_PERS";
		}
		if (["b2b", "prepaid", "business-b2b"].includes(lower)) {
			return "GIGACHAT_API_B2B";
		}
		if (["corp", "corporate", "postpaid", "business-corp"].includes(lower)) {
			return "GIGACHAT_API_CORP";
		}
		const containedScopes = [...VALID_SCOPES].filter((candidate) => trimmed.toUpperCase().includes(candidate));
		if (containedScopes.length === 1) {
			return containedScopes[0];
		}
		if (containedScopes.length > 1) {
			throw new Error(
				`Invalid GigaChat scope: ${trimmed}. Set exactly one of GIGACHAT_API_PERS, GIGACHAT_API_B2B, or GIGACHAT_API_CORP.`,
			);
		}
		throw new Error(
			`Invalid GigaChat scope: ${trimmed}. Use GIGACHAT_API_PERS, GIGACHAT_API_B2B, or GIGACHAT_API_CORP.`,
		);
	}

	return scope;
}

function normalizeUser(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("GigaChat username is required");
	}
	return trimmed;
}

function normalizeAccountType(input: string): GigaChatAccountType {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed) {
		return "personal";
	}

	if (["personal", "pers", "individual", "gigachat_api_pers"].includes(trimmed)) {
		return "personal";
	}

	if (["business", "biz", "company"].includes(trimmed)) {
		return "business";
	}

	throw new Error(`Invalid GigaChat account type: ${input.trim()}. Use personal or business.`);
}

function normalizeAuthMode(input: string): GigaChatAuthMode {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed) {
		return DEFAULT_AUTH_MODE;
	}

	if (["basic", "password", "username/password", "username-password", "login", "userpass"].includes(trimmed)) {
		return "basic";
	}

	if (["token", "access-token", "access", "bearer"].includes(trimmed)) {
		return "token";
	}

	throw new Error(`Invalid GigaChat auth mode: ${input.trim()}. Use basic or token.`);
}

function getDefaultScope(accountType: GigaChatAccountType): GigaChatScope {
	return accountType === "business" ? DEFAULT_BUSINESS_SCOPE : DEFAULT_SCOPE;
}

function getScopeChoices(accountType: GigaChatAccountType): string[] {
	return accountType === "business"
		? ["B2B (GIGACHAT_API_B2B)", "Corp (GIGACHAT_API_CORP)", "Personal (GIGACHAT_API_PERS)"]
		: ["Personal (GIGACHAT_API_PERS)", "B2B (GIGACHAT_API_B2B)", "Corp (GIGACHAT_API_CORP)"];
}

function normalizeBaseUrlChoice(input: string): GigaChatBaseUrlChoice {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed || trimmed.startsWith("default")) {
		return "default";
	}

	if (trimmed === "custom") {
		return "custom";
	}

	return "custom";
}

function normalizeBaseUrl(input: string, fallbackBaseUrl: string = DEFAULT_BASE_URL): string {
	const trimmed = input.trim();
	if (!trimmed || trimmed.toLowerCase().startsWith("default")) {
		return fallbackBaseUrl;
	}

	if (!/^https?:\/\//i.test(trimmed)) {
		throw new Error(`Invalid GigaChat base URL: ${trimmed}. Use an absolute http(s) URL.`);
	}

	return trimmed.replace(/\/+$/, "");
}

function normalizeStoredBaseUrl(input: unknown): string | undefined {
	if (typeof input !== "string" || input.trim().length === 0) {
		return undefined;
	}

	try {
		return normalizeBaseUrl(input);
	} catch {
		return undefined;
	}
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

function createClient(authorizationKey: string, scope: GigaChatScope, baseUrl: string): PiGigaChatClient {
	const config = {
		credentials: authorizationKey,
		scope,
		baseUrl,
	} satisfies GigaChatClientConfig;

	return new PiGigaChatClient(config);
}

function createBasicClient(user: string, password: string, baseUrl: string): PiGigaChatClient {
	const config = {
		user,
		password,
		baseUrl,
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
	options?: {
		baseUrl?: string;
		signal?: AbortSignal;
	},
): Promise<OAuthCredentials> {
	if (options?.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const normalizedAuthorizationKey = normalizeAuthorizationKey(authorizationKey);
	const normalizedBaseUrl = normalizeBaseUrl(options?.baseUrl ?? "", DEFAULT_BASE_URL);
	const client = createClient(normalizedAuthorizationKey, scope, normalizedBaseUrl);

	try {
		await updateToken(client);
	} catch (error) {
		if (options?.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw withCertificateHint(error);
	}

	if (options?.signal?.aborted) {
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
		authMode: "token",
		authorizationKey: normalizedAuthorizationKey,
		scope,
		baseUrl: normalizedBaseUrl,
	};
}

async function requestBasicAccessToken(
	user: string,
	password: string,
	options: {
		accountType: GigaChatAccountType;
		baseUrl?: string;
		scope?: GigaChatScope;
		signal?: AbortSignal;
	},
): Promise<OAuthCredentials> {
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const normalizedUser = normalizeUser(user);
	const normalizedPassword = normalizePassword(password);
	const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl ?? "", DEFAULT_BASE_URL);
	const client = createBasicClient(normalizedUser, normalizedPassword, normalizedBaseUrl);

	try {
		await updateToken(client);
	} catch (error) {
		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw withCertificateHint(error);
	}

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const data = client.accessTokenData;

	if (!data || typeof data.access_token !== "string" || data.access_token.length === 0) {
		throw new Error("Invalid GigaChat token response: missing access_token");
	}

	return {
		access: data.access_token,
		refresh: "",
		expires: parseExpiresAt(data.expires_at),
		authMode: "basic",
		accountType: options.accountType,
		scope: normalizeScope(options.scope ?? "", getDefaultScope(options.accountType)),
		baseUrl: normalizedBaseUrl,
		user: normalizedUser,
		password: normalizedPassword,
	};
}

export async function refreshGigaChatToken(
	authorizationKey: string,
	scope: GigaChatScope = DEFAULT_SCOPE,
	options?: {
		baseUrl?: string;
		signal?: AbortSignal;
	},
): Promise<OAuthCredentials> {
	return requestAccessToken(authorizationKey, normalizeScope(scope), options);
}

export async function loginGigaChat(options: {
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const rawAccountType = await options.onPrompt({
		message: "GigaChat account type (personal/business)",
		placeholder: "personal",
		allowEmpty: true,
		choices: ["Personal", "Business"],
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const rawAuthMode = await options.onPrompt({
		message: "GigaChat auth mode (basic/token)",
		placeholder: DEFAULT_AUTH_MODE,
		allowEmpty: true,
		choices: ["Basic", "Token"],
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const accountType = normalizeAccountType(rawAccountType);
	const authMode = normalizeAuthMode(rawAuthMode);
	const defaultScope = getDefaultScope(accountType);
	const rawScope = await options.onPrompt({
		message: "GigaChat scope",
		placeholder: defaultScope,
		allowEmpty: true,
		choices: getScopeChoices(accountType),
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const scope = normalizeScope(rawScope, defaultScope);
	const rawBaseUrlChoice = await options.onPrompt({
		message: "GigaChat base URL",
		placeholder: DEFAULT_BASE_URL,
		allowEmpty: true,
		choices: [DEFAULT_BASE_URL_CHOICE, CUSTOM_BASE_URL_CHOICE],
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const baseUrlChoice = normalizeBaseUrlChoice(rawBaseUrlChoice);
	let baseUrl = normalizeBaseUrl(baseUrlChoice === "custom" ? "" : rawBaseUrlChoice, DEFAULT_BASE_URL);
	if (baseUrlChoice === "custom") {
		const rawBaseUrl = await options.onPrompt({
			message: "Custom GigaChat base URL",
			placeholder: DEFAULT_BASE_URL,
			allowEmpty: true,
		});

		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		baseUrl = normalizeBaseUrl(rawBaseUrl, DEFAULT_BASE_URL);
	}

	if (authMode === "basic") {
		const rawUser = await options.onPrompt({
			message: "GigaChat username",
			placeholder: "username",
		});

		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const rawPassword = await options.onPrompt({
			message: "GigaChat password",
			placeholder: "password",
		});

		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		options.onProgress?.("Requesting GigaChat access token...");
		return requestBasicAccessToken(rawUser, rawPassword, {
			accountType,
			baseUrl,
			scope,
			signal: options.signal,
		});
	}

	if (authMode === "token") {
		const rawTokenCredentials = await options.onPrompt({
			message: "GigaChat token",
			placeholder: "Basic <authorization_key>",
		});

		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		options.onProgress?.("Requesting GigaChat access token...");
		const credentials = await requestAccessToken(rawTokenCredentials, scope, {
			baseUrl,
			signal: options.signal,
		});
		return {
			...credentials,
			accountType,
		};
	}

	throw new Error(`Unsupported GigaChat auth mode: ${authMode}`);
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
		if (
			gigachatCredentials.authMode === "password" ||
			gigachatCredentials.authMode === "basic" ||
			(typeof gigachatCredentials.user === "string" && typeof gigachatCredentials.password === "string")
		) {
			const user = typeof gigachatCredentials.user === "string" ? gigachatCredentials.user : undefined;
			const password = typeof gigachatCredentials.password === "string" ? gigachatCredentials.password : undefined;
			if (!user || !password) {
				throw new Error("GigaChat credentials missing username or password");
			}
			const accountType = gigachatCredentials.accountType === "business" ? "business" : "personal";
			return requestBasicAccessToken(user, password, {
				accountType,
				baseUrl: gigachatCredentials.baseUrl,
				scope:
					typeof gigachatCredentials.scope === "string"
						? normalizeScope(gigachatCredentials.scope, getDefaultScope(accountType))
						: undefined,
			});
		}

		const authorizationKey =
			typeof gigachatCredentials.authorizationKey === "string" && gigachatCredentials.authorizationKey.length > 0
				? gigachatCredentials.authorizationKey
				: gigachatCredentials.refresh;

		if (typeof authorizationKey !== "string" || authorizationKey.length === 0) {
			if (gigachatCredentials.authMode === "token") {
				throw new Error(
					"GigaChat token login is missing the original credentials key and cannot be refreshed automatically. Run /login gigachat again.",
				);
			}
			throw new Error("GigaChat credentials missing authorization key");
		}

		const scope = normalizeScope(
			typeof gigachatCredentials.scope === "string" ? gigachatCredentials.scope : DEFAULT_SCOPE,
		);
		return refreshGigaChatToken(authorizationKey, scope, {
			baseUrl: gigachatCredentials.baseUrl,
		});
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const baseUrl = normalizeStoredBaseUrl((credentials as GigaChatCredentials).baseUrl);
		if (!baseUrl) {
			return models;
		}

		return models.map((model) => (model.provider === "gigachat" ? { ...model, baseUrl } : model));
	},
};
