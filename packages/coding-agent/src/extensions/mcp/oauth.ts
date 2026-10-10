/**
 * OAuth sign-in for remote MCP servers.
 *
 * Connections never start a browser flow on their own. They send the stored access token and, after
 * a 401, try the stored refresh token. When that is not possible they fail with
 * `McpOAuthAuthorizationRequiredError`, and the user signs in through `/mcp`, which runs
 * the authorization code flow (PKCE, a Client ID Metadata Document or dynamic client registration)
 * against a loopback callback.
 *
 * Credentials live in `<agent-dir>/mcp-auth.json`, keyed by server name and URL.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import {
	type AuthorizationServerMetadata,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	type McpOAuthStateStore,
	type OAuthCallback,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthChallenge,
	type OAuthClientInformationMixed,
	type OAuthClientMetadataDocument,
	parseWwwAuthenticate,
	stepUpScope,
} from "@earendil-works/pi-mcp/oauth";
import lockfile from "proper-lockfile";
import { APP_NAME, getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { mcpNamespace } from "../../core/mcp-servers.ts";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** Where pi.dev serves pi's Client ID Metadata Documents: `client.json` and `<callback ID>/client.json`. */
const CLIENT_METADATA_BASE_URL = "https://pi.dev/oauth";
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;
/**
 * Bounds each request to the authorization server, so an unresponsive one cannot hold the refresh lock,
 * delay shutdown, or keep a sign-in waiting for long.
 */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
/** A refresh lock that its holder stopped renewing (the process was killed) is taken over after this. */
const REFRESH_LOCK_STALE_MS = 20_000;
/** How long to wait for another process's refresh: longer than a stale lock lives. */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;

export interface McpOAuthSettings {
	clientId?: string;
	/** Already resolved. */
	clientSecret?: string;
	callbackPort?: number;
	/** Loopback redirect URI; see `McpOAuthConfig.callbackUrl`. */
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. */
	scope?: string;
	/** `client_name` for dynamic client registration. Default: `APP_NAME`. */
	clientName?: string;
	/** See `McpOAuthConfig.clientRegistration`. */
	clientRegistration?: "dcr" | "cimd";
	/** See `McpOAuthConfig.authServerMetadataUrl`. */
	authServerMetadataUrl?: URL;
}

/** Where the loopback callback server listens and the redirect URI it serves. */
interface CallbackSettings {
	/** Address to listen on. */
	host: string;
	/** Host name in the redirect URI. */
	redirectHost: string;
	port: number | undefined;
	path: string;
	/** The exact redirect URI, when the port is fixed. */
	fixedRedirectUrl: string | undefined;
}

function callbackSettings(settings: McpOAuthSettings): CallbackSettings {
	const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
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
		// `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
		host: address === "localhost" ? CALLBACK_HOST : address,
		redirectHost: address,
		port,
		path: url.pathname,
		fixedRedirectUrl,
	};
}

/** Scopes of both lists, each once. */
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	return merged.length > 0 ? merged.join(" ") : undefined;
}

type StoredStates = Record<string, McpOAuthState>;

function parseStates(content: string | undefined): StoredStates {
	if (!content?.trim()) return {};
	const parsed: unknown = JSON.parse(content);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredStates) : {};
}

function serializeStates(states: StoredStates): string {
	return `${JSON.stringify(states, null, 2)}\n`;
}

/**
 * Keys of a server's state: by name and URL, so servers sharing a URL keep separate accounts, and the
 * legacy key by URL alone, written by older versions.
 */
function storeKeys(name: string, serverUrl: string): { key: string; legacyKey: string } {
	const legacyKey = String(new URL(serverUrl));
	return { key: `${mcpNamespace(name)}|${legacyKey}`, legacyKey };
}

export interface McpOAuthServerStore extends McpOAuthStateStore {
	/** Run `fn` while no other process refreshes the server's tokens. */
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Per-server OAuth state (client registration, tokens, pending PKCE verifier) in `mcp-auth.json`. */
export class McpOAuthCredentialStore {
	private readonly backend: AuthStorageBackend;
	/** Directory for the refresh lock files. Without one, refreshes are only serialized in this process. */
	private readonly lockDir: string | undefined;

	constructor(backend?: AuthStorageBackend, lockDir?: string) {
		this.backend = backend ?? new FileAuthStorageBackend(join(getAgentDir(), "mcp-auth.json"));
		this.lockDir = backend ? lockDir : getAgentDir();
	}

	forServer(name: string, serverUrl: string): McpOAuthServerStore {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		return {
			// The first server to load legacy state takes it over; others with the same URL sign in again.
			load: () =>
				this.backend.withLock((current) => {
					const states = parseStates(current);
					if (states[key] || !states[legacyKey]) return { result: states[key] };
					states[key] = states[legacyKey];
					delete states[legacyKey];
					return { result: states[key], next: serializeStates(states) };
				}),
			save: (state) =>
				this.write((states) => {
					states[key] = state;
				}),
			withRefreshLock: (fn) => this.withRefreshLock(key, fn),
		};
	}

	/**
	 * A lock file per server. When the process exits, proper-lockfile removes the locks it holds; when
	 * it is killed, the lock goes stale because it is no longer renewed, and the next process takes it over.
	 */
	private async withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		if (!this.lockDir) return fn();
		mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		const release = await lockfile.lock(join(this.lockDir, `mcp-auth-refresh-${hash}`), {
			realpath: false,
			stale: REFRESH_LOCK_STALE_MS,
			retries: {
				retries: REFRESH_LOCK_WAIT_MS / REFRESH_LOCK_RETRY_MS,
				factor: 1,
				minTimeout: REFRESH_LOCK_RETRY_MS,
				maxTimeout: REFRESH_LOCK_RETRY_MS,
			},
			// The default throws from a timer. A lost lock at worst lets two refreshes overlap.
			onCompromised: () => {},
		});
		try {
			return await fn();
		} finally {
			await release().catch(() => undefined);
		}
	}

	/** The stored tokens of a server, for noticing sign-ins done by another process. Does not take over legacy state. */
	tokens(name: string, serverUrl: string): McpOAuthState["tokens"] {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		const states = this.backend.withLock((current) => ({ result: parseStates(current) }));
		return (states[key] ?? states[legacyKey])?.tokens;
	}

	/** Returns whether credentials were stored for the server. Removes legacy state the server would take over. */
	remove(name: string, serverUrl: string): boolean {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		return this.backend.withLock((current) => {
			const states = parseStates(current);
			const stored = key in states ? key : legacyKey in states ? legacyKey : undefined;
			if (!stored) return { result: false };
			delete states[stored];
			return { result: true, next: serializeStates(states) };
		});
	}

	private write(update: (states: StoredStates) => void): void {
		this.backend.withLock((current) => {
			const states = parseStates(current);
			update(states);
			return { result: undefined, next: serializeStates(states) };
		});
	}
}

/** `fetch` with `OAUTH_REQUEST_TIMEOUT_MS` per request, on top of the request's own signal. */
function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

/** 12 characters identifying an MCP server URL in callback paths, computed like Codex does. */
function callbackId(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

/**
 * pi's Client ID Metadata Document, for `clientRegistration: "cimd"`, chosen like Codex chooses its own.
 * The configuration ensures the default callback path. Without the `iss` parameter in authorization
 * responses (RFC 9207), the redirect URI and the document are specific to the MCP server, so a response
 * cannot be mixed up with one from another authorization server (RFC 9700 section 4.4.2.2).
 */
function clientMetadataDocument(
	serverUrl: string,
	redirectUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
): OAuthClientMetadataDocument {
	if (
		!metadata?.client_id_metadata_document_supported ||
		!metadata.token_endpoint_auth_methods_supported?.includes("none")
	) {
		throw new Error(
			'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
		);
	}
	if (metadata.authorization_response_iss_parameter_supported) {
		return { url: `${CLIENT_METADATA_BASE_URL}/client.json`, redirectUrl };
	}
	const id = callbackId(serverUrl);
	const redirect = new URL(redirectUrl);
	redirect.pathname = `${CALLBACK_PATH}/${id}`;
	return { url: `${CLIENT_METADATA_BASE_URL}/${id}/client.json`, redirectUrl: redirect.href };
}

function createProvider(
	serverUrl: string,
	store: McpOAuthStateStore,
	settings: McpOAuthSettings,
	redirectUrl: string,
	onRedirect: (url: URL) => void,
): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? APP_NAME },
		clientMetadataDocument:
			settings.clientRegistration === "cimd"
				? (metadata) => clientMetadataDocument(serverUrl, redirectUrl, metadata)
				: undefined,
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		store,
		onRedirect,
	});
}

export interface McpAuthProvider extends AuthProvider {
	/** Resolves when no refresh is running, so shutdown does not drop rotated tokens before they are saved. */
	settled(): Promise<void>;
}

/**
 * Auth provider for MCP connections: sends the stored access token and refreshes it when it is about
 * to expire or after a 401. Throws `McpOAuthAuthorizationRequiredError` when the user has to sign in,
 * including when the server asks for more scope (`insufficient_scope`). `onChallenge` receives the
 * server's `WWW-Authenticate` challenge so sign-in can use its resource metadata URL and scope.
 * `settings` is only called when a refresh is needed, so a secret that fails to resolve fails the
 * refresh instead of the whole connection setup.
 *
 * Many servers rotate refresh tokens, so two refreshes with the same refresh token lose the grant.
 * Requests in this process share one refresh, and other processes are kept out by the store's
 * refresh lock, held from reading the tokens to saving new ones. Tokens that changed meanwhile
 * (another process refreshed them, or the user signed in) are used without refreshing.
 */
export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: () => McpOAuthSettings;
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
	const { serverUrl, store } = options;
	let refreshing: Promise<void> | undefined;

	/** Replace `staleToken`, the access token that expired or was rejected. */
	const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
		refreshing ??= store
			.withRefreshLock(async () => {
				const state = await store.load();
				if (state?.tokens?.access_token !== staleToken) return;
				if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const settings = options.settings();
				const redirectUrl =
					callbackSettings(settings).fixedRedirectUrl ??
					registeredRedirectUrls(state.clientInformation)[0] ??
					FALLBACK_REDIRECT_URL;
				const provider = createProvider(serverUrl, store, settings, redirectUrl, () => {});
				// Refreshes the tokens, or reports that a new sign-in is needed. Not cancellable: a refresh the
				// server answered may have rotated the refresh token, so its answer must be saved.
				const result = await authorizeMcp(provider, {
					serverUrl,
					resourceMetadataUrl: challenge?.resourceMetadataUrl,
					authorizationServerMetadataUrl: settings.authServerMetadataUrl,
					scope: challenge?.scope,
					fetch: timedFetch(fetch),
				});
				if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
			})
			.finally(() => {
				refreshing = undefined;
			});
		return refreshing;
	};

	return {
		token: async () => {
			await refreshing?.catch(() => undefined);
			const state = await store.load();
			const token = state?.tokens?.access_token;
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			// Failures fall through: the request goes out with the old token and a 401 decides what happens.
			await refresh(token).catch(() => undefined);
			return (await store.load())?.tokens?.access_token;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			// A refresh keeps the granted scope, so more scope needs a new sign-in.
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			await refresh(context.token, context.fetch, challenge);
		},
		settled: async () => {
			await refreshing?.catch(() => undefined);
		},
	};
}

export interface McpSignInPrompt {
	/** Show the authorization URL to the user and open it in a browser. */
	showAuthorizationUrl(url: URL): void;
	/**
	 * Ask for the redirect URL from the browser address bar, for when the browser cannot reach the
	 * loopback callback (for example over SSH). Aborted once the callback arrives or the sign-in is
	 * cancelled. Resolves to `undefined` or an empty string when the user cancels.
	 */
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}

type AuthorizationResponse = Pick<OAuthCallback, "code" | "iss" | "respond">;

export type McpSignInResult = {
	browserResponseSent: boolean;
};

function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL): AuthorizationResponse {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Expected the full redirect URL from the browser address bar");
	}
	// A server-specific redirect URI tells authorization servers apart, so it must match exactly.
	if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
		throw new Error("The redirect URL does not match this sign-in's redirect URI");
	}
	const error = url.searchParams.get("error");
	if (error) throw new Error(url.searchParams.get("error_description") ?? error);
	if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
	const code = url.searchParams.get("code");
	if (!code) throw new Error("The redirect URL does not contain an authorization code");
	return { code, iss: url.searchParams.get("iss") ?? undefined };
}

/**
 * Wait for the browser callback or a pasted redirect URL, whichever comes first. Aborting `signal`
 * aborts the prompt, which then cancels the sign-in.
 */
async function waitForAuthorizationResponse(
	callback: OAuthCallbackServer,
	state: string,
	redirectUrl: URL,
	prompt: McpSignInPrompt,
	signal: AbortSignal | undefined,
	deferBrowserResponse: boolean,
): Promise<AuthorizationResponse> {
	const controller = new AbortController();
	const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
	const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname, {
		deferResponse: deferBrowserResponse,
	});
	const fromUser = prompt.promptForRedirectUrl(promptSignal).then((input) => {
		if (!input?.trim()) throw new McpSignInCancelledError();
		return responseFromRedirectUrl(input, state, redirectUrl);
	});
	try {
		return await Promise.race([fromBrowser, fromUser]);
	} finally {
		// The losing side rejects once the prompt is aborted or the callback server closes.
		controller.abort();
		fromBrowser.catch(() => undefined);
		fromUser.catch(() => undefined);
	}
}

/** Listen on `port`, or on a free port when it is taken and not `required`. */
async function listenForCallback(
	settings: CallbackSettings,
	extraPaths: string[],
	port: number | undefined,
	required: boolean,
): Promise<OAuthCallbackServer> {
	const options = {
		host: settings.host,
		redirectHost: settings.redirectHost,
		path: settings.path,
		extraPaths,
		renderPage: (page: OAuthCallbackPage) =>
			page.ok
				? oauthSuccessHtml("Signed in to the MCP server. You may now close this page.")
				: oauthErrorHtml(page.message, page.details),
	};
	try {
		return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
	} catch (error) {
		if (required || port === undefined) throw error;
		return OAuthCallbackServer.listen(options);
	}
}

/**
 * Sign in to an MCP server. Uses the stored refresh token when possible; otherwise runs the browser
 * authorization code flow. Tokens are saved to `store`. Aborting `signal` stops the sign-in at any
 * step with `McpSignInCancelledError`; requests to the authorization server are also time-limited.
 */
export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
	signal?: AbortSignal;
	afterAuthorization?: () => Promise<string | URL | undefined>;
}): Promise<McpSignInResult> {
	const { serverUrl, store, settings, signal } = options;
	if (signal?.aborted) throw new McpSignInCancelledError();
	const stored = await store.load();
	const stepUp = options.challenge?.error === "insufficient_scope";
	const callbackOptions = callbackSettings(settings);
	// Reuse the port of the registered redirect URI so the registered client stays valid.
	const registered = registeredRedirectUrls(stored?.clientInformation)[0];
	const preferredPort =
		callbackOptions.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
	const cimd = settings.clientRegistration === "cimd";
	const callback = await listenForCallback(
		callbackOptions,
		// The redirect URI of a server-specific Client ID Metadata Document.
		cimd ? [`${CALLBACK_PATH}/${callbackId(serverUrl)}`] : [],
		preferredPort,
		callbackOptions.port !== undefined,
	);
	const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
	try {
		if (stored) {
			const next: McpOAuthState = { ...stored };
			// Every sign-in gets a fresh `state` parameter.
			delete next.oauthState;
			// A registered client cannot use another redirect URI, and its tokens belong to it. A Client ID
			// Metadata Document is not stored, so with one, a stored client was registered before and is replaced.
			const keepClient =
				settings.clientId ||
				(cimd ? !stored.clientInformation : registeredRedirectUrls(stored.clientInformation).includes(redirectUrl));
			if (!keepClient) {
				delete next.clientInformation;
				delete next.tokens;
				delete next.tokensExpireAt;
			}
			await store.save(next);
		}

		let authorizationUrl: URL | undefined;
		const provider = createProvider(serverUrl, store, settings, redirectUrl, (url) => {
			authorizationUrl = url;
		});
		const flow = {
			serverUrl,
			fetch: timedFetch(),
			signal,
			resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
			authorizationServerMetadataUrl: settings.authServerMetadataUrl,
			// A server asking for more scope gets it on top of the configured scope and, since the challenge
			// may list only the missing scopes, on top of the scope granted so far.
			scope: mergeScopes(
				settings.scope,
				stepUp ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope) : options.challenge?.scope,
			),
		};
		// A refresh keeps the granted scope; a server asking for more needs the browser flow.
		const skipRefresh = stepUp;
		if ((await authorizeMcp(provider, { ...flow, skipRefresh })) === "AUTHORIZED") {
			return { browserResponseSent: false };
		}
		if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");

		const state = await provider.state();
		// The flow picks the redirect URI, which may be specific to the MCP server.
		const authorizationRedirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
		options.prompt.showAuthorizationUrl(authorizationUrl);
		const callbackResult = await waitForAuthorizationResponse(
			callback,
			state,
			authorizationRedirectUrl,
			options.prompt,
			signal,
			Boolean(options.afterAuthorization),
		);
		const { code, iss } = callbackResult;
		try {
			await authorizeMcp(provider, { ...flow, authorizationCode: code, iss });
			const redirectUrl = await options.afterAuthorization?.();
			if (redirectUrl) {
				const browserResponseSent = callbackResult.respond?.({ redirectUrl: String(redirectUrl) }) ?? false;
				return { browserResponseSent };
			}
			const browserResponseSent = callbackResult.respond?.({ ok: true }) ?? false;
			return { browserResponseSent };
		} catch (error) {
			callbackResult.respond?.({
				ok: false,
				message: "Authorization failed. You may close this window.",
				details: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	} catch (error) {
		// Aborted requests fail with the signal's reason; report them as the cancellation they are.
		if (signal?.aborted) throw new McpSignInCancelledError();
		throw error;
	} finally {
		await callback.close();
	}
}
