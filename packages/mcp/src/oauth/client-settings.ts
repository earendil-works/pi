/**
 * The OAuth client that sign-in and refreshes use for one MCP server: its settings, how it identifies
 * itself (a pre-registered client, a Client ID Metadata Document, or dynamic client registration), and
 * the `McpOAuthProvider` built from them.
 */

import { createHash } from "node:crypto";
import type { McpFetch } from "../auth-provider.ts";
import type { OAuthClientMetadataDocument } from "./flow.ts";
import { McpOAuthProvider, type McpOAuthStateStore } from "./provider.ts";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed } from "./types.ts";

/** Client settings of one MCP server, usually from the application's configuration. */
export interface McpOAuthSettings {
	/** Pre-registered client id. Without it, sign-in uses a Client ID Metadata Document or registers a client. */
	clientId?: string;
	/** Already resolved. */
	clientSecret?: string;
	/**
	 * Port of the loopback callback server, for clients registered with a fixed redirect URI. Without
	 * `callbackUrl`, the redirect URI is `http://127.0.0.1:<port>/callback`. Only `listenForLoopbackSignIn`
	 * and the redirect URI of refreshes use it; `startMcpSignIn` and `completeMcpSignIn` take theirs from
	 * the caller.
	 */
	callbackPort?: number;
	/**
	 * Loopback redirect URI registered for `clientId`, for example `http://localhost:8080/oauth/callback`.
	 * Without a port, the callback server listens on `callbackPort` or a free port, which is added to the
	 * URI (RFC 8252). Default: `http://127.0.0.1/callback`. Like `callbackPort`, only `listenForLoopbackSignIn`
	 * and refreshes use it.
	 */
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. Default: the scopes the server advertises. */
	scope?: string;
	/** `client_name` for dynamic client registration. Default: the application's `clientName`. */
	clientName?: string;
	/**
	 * How to identify without `clientId`. `auto` (default): a Client ID Metadata Document when the
	 * authorization server supports them for public clients and the documents list the redirect URI,
	 * otherwise dynamic client registration; with `clientName`, always dynamic client registration.
	 * `cimd`: always the document, and sign-in fails without support. `dcr`: always dynamic client
	 * registration.
	 */
	clientRegistration?: "auto" | "dcr" | "cimd";
	/**
	 * Authorization server metadata document to use instead of discovery through the server, for servers
	 * that advertise a wrong authorization server or none. It is trusted as configured.
	 */
	authServerMetadataUrl?: URL;
}

/**
 * The Client ID Metadata Documents an application publishes: `<baseUrl>/client.json`, and for each MCP
 * server `<baseUrl>/<callback ID>/client.json`, whose redirect URIs carry the path `<path>/<callback ID>`.
 */
export interface McpClientMetadataDocuments {
	/** For example `https://pi.dev/oauth`. */
	baseUrl: string;
	/** Whether the documents list `redirectUrl`. Loopback redirect URIs match on any port (RFC 8252). */
	listsRedirectUrl(redirectUrl: string): boolean;
}

/** State store of one MCP server, with a lock that keeps other processes from refreshing at the same time. */
export interface McpOAuthServerStore extends McpOAuthStateStore {
	/**
	 * Run `fn` while no other process refreshes the server's tokens. Not reentrant: `startMcpSignIn` and
	 * `createMcpAuthProvider` take it themselves, so never call them from `fn`. Throw
	 * `McpRefreshLockBusyError` when another process holds the lock for the whole wait: `startMcpSignIn`
	 * then goes to the browser step. Any other error fails the sign-in or refresh.
	 */
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** The OAuth client of one MCP server: where its state lives, its settings, and the application's identity. */
export interface McpOAuthClientOptions {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: McpOAuthSettings;
	/** `client_name` for dynamic client registration unless `settings.clientName` names another: the application. */
	clientName: string;
	/** Omitted: dynamic client registration only. */
	clientMetadataDocuments?: McpClientMetadataDocuments;
}

/** An `McpOAuthProvider` for the client, redirecting to `redirectUrl` or the document's variant of it. */
export function createOAuthClientProvider(
	options: McpOAuthClientOptions,
	redirectUrl: string,
	onRedirect: (url: URL) => void = () => {},
): McpOAuthProvider {
	const { serverUrl, settings, clientMetadataDocuments: documents } = options;
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? options.clientName },
		clientMetadataDocument: offersClientMetadataDocument(settings, documents, redirectUrl)
			? (metadata) => {
					if (!documents?.listsRedirectUrl(redirectUrl)) {
						throw new Error(
							`oauth.clientRegistration "cimd" needs Client ID Metadata Documents that list the redirect URI ${redirectUrl}`,
						);
					}
					const document = clientMetadataDocument(serverUrl, redirectUrl, metadata, documents.baseUrl);
					if (!document && settings.clientRegistration === "cimd") {
						throw new Error(
							'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
						);
					}
					return document;
				}
			: undefined,
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		store: options.store,
		onRedirect,
	});
}

/**
 * Whether the client may identify with a Client ID Metadata Document instead of registering. `auto`
 * registers when the user asked for a client name or the documents do not list the redirect URI.
 */
export function offersClientMetadataDocument(
	settings: McpOAuthSettings,
	documents: McpClientMetadataDocuments | undefined,
	redirectUrl: string,
): boolean {
	const registration = settings.clientRegistration ?? "auto";
	if (registration !== "auto") return registration === "cimd";
	return !settings.clientId && !settings.clientName && documents?.listsRedirectUrl(redirectUrl) === true;
}

/**
 * The Client ID Metadata Document to use, chosen like Codex chooses its own, or `undefined` when the
 * authorization server does not support documents for public clients. Without the `iss` parameter in
 * authorization responses (RFC 9207), the redirect URI and the document are specific to the MCP server,
 * so a response cannot be mixed up with one from another authorization server (RFC 9700 section 4.4.2.2).
 */
function clientMetadataDocument(
	serverUrl: string,
	redirectUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
	baseUrl: string,
): OAuthClientMetadataDocument | undefined {
	if (
		!metadata?.client_id_metadata_document_supported ||
		!metadata.token_endpoint_auth_methods_supported?.includes("none")
	) {
		return undefined;
	}
	if (metadata.authorization_response_iss_parameter_supported) return { url: `${baseUrl}/client.json`, redirectUrl };
	const redirect = new URL(redirectUrl);
	redirect.pathname = serverSpecificPath(redirect.pathname, serverUrl);
	return { url: `${baseUrl}/${callbackId(serverUrl)}/client.json`, redirectUrl: redirect.href };
}

/** The path of the redirect URI of a server-specific Client ID Metadata Document: `<path>/<callback ID>`. */
export function serverSpecificPath(path: string, serverUrl: string): string {
	return `${path.replace(/\/$/, "")}/${callbackId(serverUrl)}`;
}

/** 12 characters identifying an MCP server URL in callback paths, computed like Codex does. */
function callbackId(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

/** Redirect URIs a stored client was registered with. */
export function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

/**
 * Bounds each request to the authorization server, so an unresponsive one cannot hold the refresh lock,
 * delay shutdown, or keep a sign-in waiting for long.
 */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/** `fetch` with `OAUTH_REQUEST_TIMEOUT_MS` per request, on top of the request's own signal. */
export function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";

/** Redirect URI when the settings name none and no client is stored. */
export const DEFAULT_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;

/** Where the loopback callback server listens and the redirect URI it serves, from `callbackUrl` and `callbackPort`. */
export interface LoopbackSettings {
	/** The redirect URI, without the port unless one is configured. */
	url: string;
	/** Address to listen on. */
	host: string;
	/** Host name in the redirect URI. */
	redirectHost: string;
	port: number | undefined;
	path: string;
	/** The exact redirect URI, when the port is fixed. */
	fixedRedirectUrl: string | undefined;
}

/** The loopback callback settings of `settings`. */
export function loopbackSettings(settings: McpOAuthSettings): LoopbackSettings {
	const configured = settings.callbackUrl ?? DEFAULT_REDIRECT_URL;
	const url = new URL(configured);
	const address = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : settings.callbackPort;
	let fixedRedirectUrl: string | undefined;
	// A configured URI with a port is sent exactly as written, since servers compare it as a string.
	if (url.port) fixedRedirectUrl = settings.callbackUrl;
	else if (port !== undefined) {
		url.port = String(port);
		fixedRedirectUrl = url.href;
	}
	return {
		url: configured,
		// `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
		host: address === "localhost" ? CALLBACK_HOST : address,
		redirectHost: address,
		port,
		path: url.pathname,
		fixedRedirectUrl,
	};
}
