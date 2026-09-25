/**
 * OAuth sign-in for remote MCP servers.
 *
 * Connections never start a browser flow on their own. They send the stored access token and, after
 * a 401, try the stored refresh token. When that is not possible they fail with
 * `McpOAuthAuthorizationRequiredError`, and the user signs in with `/mcp login <server>`, which runs
 * the authorization code flow (PKCE, dynamic client registration) against a loopback callback.
 *
 * Credentials live in `<agent-dir>/mcp-auth.json`, keyed by server URL.
 */

import { join } from "node:path";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	type McpOAuthStateStore,
	OAuthCallbackServer,
	type OAuthChallenge,
	type OAuthClientInformationMixed,
	parseWwwAuthenticate,
} from "@earendil-works/pi-mcp/oauth";
import { APP_NAME, getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/oauth/callback";
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;

export interface McpOAuthSettings {
	clientId?: string;
	/** Already resolved. */
	clientSecret?: string;
	callbackPort?: number;
}

type StoredStates = Record<string, McpOAuthState>;

function parseStates(content: string | undefined): StoredStates {
	if (!content?.trim()) return {};
	const parsed: unknown = JSON.parse(content);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredStates) : {};
}

/** Per-server OAuth state (client registration, tokens, pending PKCE verifier) in `mcp-auth.json`. */
export class McpOAuthCredentialStore {
	private readonly backend: AuthStorageBackend;

	constructor(backend: AuthStorageBackend = new FileAuthStorageBackend(join(getAgentDir(), "mcp-auth.json"))) {
		this.backend = backend;
	}

	forServer(serverUrl: string): McpOAuthStateStore {
		const key = String(new URL(serverUrl));
		return {
			load: () => this.read()[key],
			save: (state) =>
				this.write((states) => {
					states[key] = state;
				}),
		};
	}

	/** Returns whether credentials were stored for the server. */
	remove(serverUrl: string): boolean {
		const key = String(new URL(serverUrl));
		if (!(key in this.read())) return false;
		this.write((states) => {
			delete states[key];
		});
		return true;
	}

	private read(): StoredStates {
		return this.backend.withLock((current) => ({ result: parseStates(current) }));
	}

	private write(update: (states: StoredStates) => void): void {
		this.backend.withLock((current) => {
			const states = parseStates(current);
			update(states);
			return { result: undefined, next: `${JSON.stringify(states, null, 2)}\n` };
		});
	}
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

function configuredRedirectUrl(settings: McpOAuthSettings): string | undefined {
	return settings.callbackPort === undefined
		? undefined
		: `http://${CALLBACK_HOST}:${settings.callbackPort}${CALLBACK_PATH}`;
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
		clientMetadata: { client_name: APP_NAME },
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		store,
		onRedirect,
	});
}

/**
 * Auth provider for MCP connections: sends the stored access token and refreshes it after a 401.
 * Throws `McpOAuthAuthorizationRequiredError` when the user has to sign in. `onChallenge` receives
 * the server's `WWW-Authenticate` challenge so sign-in can use its resource metadata URL and scope.
 */
export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	onChallenge: (challenge: OAuthChallenge) => void;
}): AuthProvider {
	const { serverUrl, store, settings } = options;
	return {
		token: async () => (await store.load())?.tokens?.access_token,
		onUnauthorized: async (context) => {
			options.onChallenge(parseWwwAuthenticate(context.response.headers.get("www-authenticate")));
			const state = await store.load();
			if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
			const redirectUrl =
				configuredRedirectUrl(settings) ??
				registeredRedirectUrls(state.clientInformation)[0] ??
				FALLBACK_REDIRECT_URL;
			// Refreshes the tokens, or throws McpOAuthAuthorizationRequiredError if a new sign-in is needed.
			await adaptOAuthProvider(createProvider(serverUrl, store, settings, redirectUrl, () => {})).onUnauthorized?.(
				context,
			);
		},
	};
}

export interface McpSignInPrompt {
	/** Show the authorization URL to the user and open it in a browser. */
	showAuthorizationUrl(url: URL): void;
	/**
	 * Ask for the redirect URL from the browser address bar, for when the browser cannot reach the
	 * loopback callback (for example over SSH). Aborted once the callback arrives. Resolves to
	 * `undefined` or an empty string when the user cancels.
	 */
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}

function codeFromRedirectUrl(input: string, state: string): string {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Expected the full redirect URL from the browser address bar");
	}
	const error = url.searchParams.get("error");
	if (error) throw new Error(url.searchParams.get("error_description") ?? error);
	if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
	const code = url.searchParams.get("code");
	if (!code) throw new Error("The redirect URL does not contain an authorization code");
	return code;
}

/** Wait for the browser callback or a pasted redirect URL, whichever comes first. */
async function waitForAuthorizationCode(
	callback: OAuthCallbackServer,
	state: string,
	prompt: McpSignInPrompt,
): Promise<string> {
	const controller = new AbortController();
	const fromBrowser = callback.waitForCallback(state).then((result) => result.code);
	const fromUser = prompt.promptForRedirectUrl(controller.signal).then((input) => {
		if (!input?.trim()) throw new McpSignInCancelledError();
		return codeFromRedirectUrl(input, state);
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

async function listenForCallback(port: number | undefined, required: boolean): Promise<OAuthCallbackServer> {
	try {
		return await OAuthCallbackServer.listen({ host: CALLBACK_HOST, port: port ?? 0, path: CALLBACK_PATH });
	} catch (error) {
		if (required || port === undefined) throw error;
		return OAuthCallbackServer.listen({ host: CALLBACK_HOST, path: CALLBACK_PATH });
	}
}

/**
 * Sign in to an MCP server. Uses the stored refresh token when possible; otherwise runs the browser
 * authorization code flow. Tokens are saved to `store`.
 */
export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
}): Promise<void> {
	const { serverUrl, store, settings } = options;
	const stored = await store.load();
	// Reuse the port of the registered redirect URI so the registered client stays valid.
	const registered = registeredRedirectUrls(stored?.clientInformation)[0];
	const preferredPort =
		settings.callbackPort ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
	const callback = await listenForCallback(preferredPort, settings.callbackPort !== undefined);
	try {
		if (stored) {
			const next: McpOAuthState = { ...stored };
			// Every sign-in gets a fresh `state` parameter.
			delete next.oauthState;
			// A registered client cannot use another redirect URI, and its tokens belong to it.
			if (!settings.clientId && !registeredRedirectUrls(stored.clientInformation).includes(callback.redirectUrl)) {
				delete next.clientInformation;
				delete next.tokens;
			}
			await store.save(next);
		}

		let authorizationUrl: URL | undefined;
		const provider = createProvider(serverUrl, store, settings, callback.redirectUrl, (url) => {
			authorizationUrl = url;
		});
		const flow = {
			serverUrl,
			resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
			scope: options.challenge?.scope,
		};
		if ((await authorizeMcp(provider, flow)) === "AUTHORIZED") return;
		if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");

		const state = await provider.state();
		options.prompt.showAuthorizationUrl(authorizationUrl);
		const code = await waitForAuthorizationCode(callback, state, options.prompt);
		await authorizeMcp(provider, { ...flow, authorizationCode: code });
	} finally {
		await callback.close();
	}
}
