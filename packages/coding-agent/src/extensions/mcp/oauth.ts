/**
 * OAuth sign-in for remote MCP servers: pi's credential store and its side of the sign-in.
 *
 * Connections never start a browser flow on their own. They send the stored access token and, after
 * a 401, try the stored refresh token. When that is not possible they fail with
 * `McpOAuthAuthorizationRequiredError`, and the user signs in through `/mcp` or `pi mcp login`, which
 * run pi-mcp's sign-in (PKCE, pi's Client ID Metadata Document or dynamic client registration) against
 * a loopback callback or a pasted redirect URL.
 *
 * Credentials live in `<agent-dir>/mcp-auth.json`, keyed by server name and URL.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import { mcpNamespace } from "@earendil-works/pi-mcp";
import {
	completeMcpSignIn,
	createMcpAuthProvider as createAuthProvider,
	listenForLoopbackSignIn,
	type McpAuthProvider,
	type McpClientMetadataDocuments,
	type McpOAuthServerStore,
	type McpOAuthSettings,
	type McpOAuthState,
	McpRefreshLockBusyError,
	type OAuthCallbackPage,
	type OAuthChallenge,
	startMcpSignIn,
	waitForLoopbackSignIn,
} from "@earendil-works/pi-mcp/oauth";
import lockfile from "proper-lockfile";
import { APP_NAME, getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { isClientMetadataDocumentCallback } from "../../core/mcp-servers.ts";

/** A refresh lock that its holder stopped renewing (the process was killed) is taken over after this. */
const REFRESH_LOCK_STALE_MS = 20_000;
/** How long to wait for another process's refresh: longer than a stale lock lives. */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;

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
	 * Throws `McpRefreshLockBusyError` when another process holds the lock for the whole wait.
	 */
	private async withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		if (!this.lockDir) return fn();
		mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		const release = await lockfile
			.lock(join(this.lockDir, `mcp-auth-refresh-${hash}`), {
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
			})
			.catch((error: unknown) => {
				// proper-lockfile reports a lock held by another process as `ELOCKED`.
				if (error instanceof Error && "code" in error && error.code === "ELOCKED")
					throw new McpRefreshLockBusyError();
				throw error;
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

/** pi's Client ID Metadata Documents on pi.dev: `client.json` and `<callback ID>/client.json`. */
const PI_CLIENT_METADATA_DOCUMENTS: McpClientMetadataDocuments = {
	baseUrl: "https://pi.dev/oauth",
	listsRedirectUrl: isClientMetadataDocumentCallback,
};

/** pi's client identity for sign-in and refresh. */
const PI_CLIENT = { clientName: APP_NAME, clientMetadataDocuments: PI_CLIENT_METADATA_DOCUMENTS };

/** `settings` for pi-mcp: a rebranded build would show up as pi with pi's documents, so `auto` registers. */
function piSettings(settings: McpOAuthSettings): McpOAuthSettings {
	const auto = (settings.clientRegistration ?? "auto") === "auto";
	return auto && APP_NAME !== "pi" ? { ...settings, clientRegistration: "dcr" } : settings;
}

/** pi-mcp's `createMcpAuthProvider` with pi's client identity. */
export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: () => McpOAuthSettings;
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
	return createAuthProvider({ ...options, ...PI_CLIENT, settings: () => piSettings(options.settings()) });
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

function renderCallbackPage(page: OAuthCallbackPage): string {
	return page.ok
		? oauthSuccessHtml("Signed in to the MCP server. You may now close this page.")
		: oauthErrorHtml(page.message, page.details);
}

/**
 * Sign in to an MCP server. Uses the stored refresh token when possible; otherwise runs the browser
 * authorization code flow against a loopback callback or a pasted redirect URL. Tokens are saved to
 * `store`. Aborting `signal` stops the sign-in at any step with `McpSignInCancelledError`; requests to
 * the authorization server are also time-limited.
 */
export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: McpOAuthSettings;
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
	signal?: AbortSignal;
}): Promise<void> {
	const { serverUrl, store, challenge, prompt, signal } = options;
	const settings = piSettings(options.settings);
	const { callback, redirectUrl } = await listenForLoopbackSignIn({
		serverUrl,
		store,
		settings,
		clientMetadataDocuments: PI_CLIENT_METADATA_DOCUMENTS,
		renderPage: renderCallbackPage,
	});
	try {
		const signIn = { serverUrl, store, settings, redirectUrl, challenge, signal, ...PI_CLIENT };
		const authorization = await startMcpSignIn(signIn);
		if (authorization.kind === "authorized") return;
		prompt.showAuthorizationUrl(new URL(authorization.authorizationUrl));
		const response = await waitForLoopbackSignIn({
			callback,
			authorization,
			promptForRedirectUrl: (promptSignal) => prompt.promptForRedirectUrl(promptSignal),
			signal,
		});
		await completeMcpSignIn({ ...signIn, authorization, response });
	} finally {
		await callback.close();
	}
}
