/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove SDK/Zod dependencies and use WebCrypto for PKCE.
 */

import type { AuthProvider, UnauthorizedContext } from "../auth-provider.ts";
import type { McpFetch } from "../streamable-http.ts";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	parseWwwAuthenticate,
	selectResource,
} from "./discovery.ts";
import {
	McpOAuthAuthorizationRequiredError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthRegistrationError,
} from "./errors.ts";
import {
	type AuthorizationServerMetadata,
	type OAuthClientInformation,
	type OAuthClientInformationFull,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthDiscoveryState,
	type OAuthTokens,
	parseClientInformation,
	parseOAuthTokens,
} from "./types.ts";

export type AddClientAuthentication = (
	headers: Headers,
	params: URLSearchParams,
	url: string | URL,
	metadata?: AuthorizationServerMetadata,
) => void | Promise<void>;

export interface OAuthClientProvider {
	readonly redirectUrl: string | URL;
	readonly clientMetadata: OAuthClientMetadata;
	readonly clientMetadataUrl?: string;
	state?(): string | Promise<string>;
	clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
	saveClientInformation?(information: OAuthClientInformationMixed): void | Promise<void>;
	tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
	saveTokens(tokens: OAuthTokens): void | Promise<void>;
	redirectToAuthorization(url: URL): void | Promise<void>;
	saveCodeVerifier(verifier: string): void | Promise<void>;
	codeVerifier(): string | Promise<string>;
	addClientAuthentication?: AddClientAuthentication;
	invalidateCredentials?(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void | Promise<void>;
	saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
	discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
}

export interface OAuthFlowOptions {
	serverUrl: string | URL;
	authorizationCode?: string;
	scope?: string;
	resourceMetadataUrl?: URL;
	fetch?: McpFetch;
	skipIssuerValidation?: boolean;
}

export type OAuthFlowResult = "AUTHORIZED" | "REDIRECT";
type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

function loopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function secureEndpoint(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" && !loopback(url.hostname)) throw new OAuthInsecureEndpointError(url.href);
	return url;
}

function selectClientAuthMethod(information: OAuthClientInformationMixed, supported: string[]): ClientAuthMethod {
	const hinted = "token_endpoint_auth_method" in information ? information.token_endpoint_auth_method : undefined;
	if (
		hinted &&
		["client_secret_basic", "client_secret_post", "none"].includes(hinted) &&
		(supported.length === 0 || supported.includes(hinted))
	) {
		return hinted as ClientAuthMethod;
	}
	if (supported.length === 0) return information.client_secret ? "client_secret_basic" : "none";
	if (information.client_secret && supported.includes("client_secret_basic")) return "client_secret_basic";
	if (information.client_secret && supported.includes("client_secret_post")) return "client_secret_post";
	if (supported.includes("none")) return "none";
	return information.client_secret ? "client_secret_post" : "none";
}

function applyClientAuthentication(
	method: ClientAuthMethod,
	information: OAuthClientInformation,
	headers: Headers,
	params: URLSearchParams,
): void {
	if (method === "client_secret_basic") {
		if (!information.client_secret) throw new Error("client_secret_basic requires a client secret");
		headers.set(
			"Authorization",
			`Basic ${Buffer.from(`${information.client_id}:${information.client_secret}`).toString("base64")}`,
		);
	} else {
		params.set("client_id", information.client_id);
		if (method === "client_secret_post" && information.client_secret)
			params.set("client_secret", information.client_secret);
	}
}

async function oauthError(response: Response): Promise<OAuthError> {
	const body = await response.text();
	try {
		const value = JSON.parse(body) as Record<string, unknown>;
		if (typeof value.error === "string") {
			return new OAuthError(
				value.error,
				typeof value.error_description === "string" ? value.error_description : value.error,
				typeof value.error_uri === "string" ? value.error_uri : undefined,
			);
		}
	} catch {}
	return new OAuthError("server_error", `HTTP ${response.status}: ${body}`);
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = Buffer.from(bytes).toString("base64url");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export async function startAuthorization(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientInformation: OAuthClientInformationMixed;
		redirectUrl: string | URL;
		scope?: string;
		state?: string;
		resource?: string;
	},
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
	const metadata = options.metadata;
	if (metadata && !metadata.response_types_supported.includes("code")) {
		throw new Error("Authorization server does not support authorization codes");
	}
	if (metadata?.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
		throw new Error("Authorization server does not support PKCE S256");
	}
	const url = new URL(metadata?.authorization_endpoint ?? new URL("/authorize", authorizationServerUrl));
	const { verifier, challenge } = await pkce();
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", options.clientInformation.client_id);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("redirect_uri", String(options.redirectUrl));
	if (options.state) url.searchParams.set("state", options.state);
	if (options.scope) url.searchParams.set("scope", options.scope);
	if (options.scope?.split(/\s+/).includes("offline_access")) url.searchParams.set("prompt", "consent");
	if (options.resource) url.searchParams.set("resource", options.resource);
	return { authorizationUrl: url, codeVerifier: verifier };
}

async function tokenRequest(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		params: URLSearchParams;
		clientInformation: OAuthClientInformationMixed;
		resource?: string;
		addClientAuthentication?: AddClientAuthentication;
		fetch?: McpFetch;
	},
): Promise<OAuthTokens> {
	const url = secureEndpoint(options.metadata?.token_endpoint ?? new URL("/token", authorizationServerUrl));
	const headers = new Headers({ Accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
	if (options.resource) options.params.set("resource", options.resource);
	if (options.addClientAuthentication) {
		await options.addClientAuthentication(headers, options.params, url, options.metadata);
	} else {
		applyClientAuthentication(
			selectClientAuthMethod(
				options.clientInformation,
				options.metadata?.token_endpoint_auth_methods_supported ?? [],
			),
			options.clientInformation,
			headers,
			options.params,
		);
	}
	const response = await (options.fetch ?? globalThis.fetch)(url, { method: "POST", headers, body: options.params });
	if (!response.ok) throw await oauthError(response);
	const value = await response.json();
	try {
		return parseOAuthTokens(value);
	} catch (error) {
		if (typeof value === "object" && value !== null && "error" in value) {
			const oauthResponse = value as Record<string, unknown>;
			throw new OAuthError(
				String(oauthResponse.error),
				String(oauthResponse.error_description ?? oauthResponse.error),
			);
		}
		throw error;
	}
}

export async function registerClient(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientMetadata: OAuthClientMetadata;
		scope?: string;
		fetch?: McpFetch;
	},
): Promise<OAuthClientInformationFull> {
	const endpoint = options.metadata?.registration_endpoint;
	if (options.metadata && !endpoint)
		throw new Error("Authorization server does not support dynamic client registration");
	const response = await (options.fetch ?? globalThis.fetch)(
		new URL(endpoint ?? new URL("/register", authorizationServerUrl)),
		{
			method: "POST",
			headers: { Accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ ...options.clientMetadata, ...(options.scope ? { scope: options.scope } : {}) }),
		},
	);
	if (!response.ok) throw new OAuthRegistrationError(response.status, await response.text());
	return parseClientInformation(await response.json());
}

export async function exchangeAuthorizationCode(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientInformation: OAuthClientInformationMixed;
		code: string;
		codeVerifier: string;
		redirectUrl: string | URL;
		resource?: string;
		addClientAuthentication?: AddClientAuthentication;
		fetch?: McpFetch;
	},
): Promise<OAuthTokens> {
	return tokenRequest(authorizationServerUrl, {
		metadata: options.metadata,
		clientInformation: options.clientInformation,
		params: new URLSearchParams({
			grant_type: "authorization_code",
			code: options.code,
			code_verifier: options.codeVerifier,
			redirect_uri: String(options.redirectUrl),
		}),
		resource: options.resource,
		addClientAuthentication: options.addClientAuthentication,
		fetch: options.fetch,
	});
}

export async function refreshAuthorization(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientInformation: OAuthClientInformationMixed;
		refreshToken: string;
		resource?: string;
		addClientAuthentication?: AddClientAuthentication;
		fetch?: McpFetch;
	},
): Promise<OAuthTokens> {
	const tokens = await tokenRequest(authorizationServerUrl, {
		metadata: options.metadata,
		clientInformation: options.clientInformation,
		params: new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken }),
		resource: options.resource,
		addClientAuthentication: options.addClientAuthentication,
		fetch: options.fetch,
	});
	return { refresh_token: options.refreshToken, ...tokens };
}

async function runFlow(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	const cached = await provider.discoveryState?.();
	const discovered = cached?.authorizationServerUrl
		? {
				authorizationServerUrl: cached.authorizationServerUrl,
				authorizationServerMetadata:
					cached.authorizationServerMetadata ??
					(await discoverAuthorizationServerMetadata(cached.authorizationServerUrl, {
						fetch: options.fetch,
						skipIssuerValidation: options.skipIssuerValidation,
					})),
				resourceMetadata: cached.resourceMetadata,
			}
		: await discoverOAuthServerInfo(options.serverUrl, {
				resourceMetadataUrl: options.resourceMetadataUrl,
				fetch: options.fetch,
				skipIssuerValidation: options.skipIssuerValidation,
			});
	await provider.saveDiscoveryState?.({
		...discovered,
		...(options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl.href } : {}),
	});
	const metadata = discovered.authorizationServerMetadata;
	const resource = selectResource(options.serverUrl, discovered.resourceMetadata);
	const scope =
		options.scope ?? discovered.resourceMetadata?.scopes_supported?.join(" ") ?? provider.clientMetadata.scope;
	let client = await provider.clientInformation();
	if (!client) {
		if (options.authorizationCode) throw new Error("OAuth client information is missing during code exchange");
		if (metadata?.client_id_metadata_document_supported && provider.clientMetadataUrl) {
			const url = new URL(provider.clientMetadataUrl);
			if (url.protocol !== "https:" || url.pathname === "/") throw new Error("Invalid OAuth client metadata URL");
			client = { client_id: provider.clientMetadataUrl };
			await provider.saveClientInformation?.(client);
		} else {
			if (!provider.saveClientInformation) throw new Error("OAuth client information cannot be persisted");
			client = await registerClient(discovered.authorizationServerUrl, {
				metadata,
				clientMetadata: provider.clientMetadata,
				scope,
				fetch: options.fetch,
			});
			await provider.saveClientInformation(client);
		}
	}
	if (options.authorizationCode) {
		const tokens = await exchangeAuthorizationCode(discovered.authorizationServerUrl, {
			metadata,
			clientInformation: client,
			code: options.authorizationCode,
			codeVerifier: await provider.codeVerifier(),
			redirectUrl: provider.redirectUrl,
			resource,
			addClientAuthentication: provider.addClientAuthentication,
			fetch: options.fetch,
		});
		await provider.saveTokens(tokens);
		return "AUTHORIZED";
	}
	const existing = await provider.tokens();
	if (existing?.refresh_token) {
		try {
			const tokens = await refreshAuthorization(discovered.authorizationServerUrl, {
				metadata,
				clientInformation: client,
				refreshToken: existing.refresh_token,
				resource,
				addClientAuthentication: provider.addClientAuthentication,
				fetch: options.fetch,
			});
			await provider.saveTokens(tokens);
			return "AUTHORIZED";
		} catch (error) {
			if (error instanceof OAuthInsecureEndpointError) throw error;
			if (error instanceof OAuthError && error.code !== "server_error") throw error;
		}
	}
	const state = await provider.state?.();
	const authorization = await startAuthorization(discovered.authorizationServerUrl, {
		metadata,
		clientInformation: client,
		redirectUrl: provider.redirectUrl,
		scope,
		state,
		resource,
	});
	await provider.saveCodeVerifier(authorization.codeVerifier);
	await provider.redirectToAuthorization(authorization.authorizationUrl);
	return "REDIRECT";
}

export async function authorizeMcp(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	try {
		return await runFlow(provider, options);
	} catch (error) {
		if (error instanceof OAuthError && ["invalid_client", "unauthorized_client"].includes(error.code)) {
			await provider.invalidateCredentials?.("all");
			return runFlow(provider, options);
		}
		if (error instanceof OAuthError && error.code === "invalid_grant") {
			await provider.invalidateCredentials?.("tokens");
			return runFlow(provider, options);
		}
		throw error;
	}
}

export function adaptOAuthProvider(provider: OAuthClientProvider): AuthProvider {
	return {
		token: async () => (await provider.tokens())?.access_token,
		onUnauthorized: async (context: UnauthorizedContext) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			const result = await authorizeMcp(provider, {
				serverUrl: context.serverUrl,
				resourceMetadataUrl: challenge.resourceMetadataUrl,
				scope: challenge.scope,
				fetch: context.fetch,
			});
			if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
		},
	};
}
