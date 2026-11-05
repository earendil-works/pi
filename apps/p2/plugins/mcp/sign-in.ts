// MCP OAuth sign-ins, a native of the manager: the auth provider every OAuth HTTP connection sends its tokens with, and
// the sign-in flows, one per server at a time. A flow redirects the browser either to a loopback callback server on the
// p2 host (the browser runs there) or to p2's own `/mcp/callback` route (the browser reaches p2 through Radius or a
// public host); the final redirect URL pasted by the owner always completes it too. Flows live in memory: a restart
// forgets them, the stored tokens stay.

import { randomUUID } from "node:crypto";
import type { McpOAuthConfig } from "@earendil-works/pi-mcp";
import {
	completeMcpSignIn,
	createMcpAuthProvider,
	listenForLoopbackSignIn,
	type McpAuthorizationResponse,
	type McpAuthProvider,
	type McpClientMetadataDocuments,
	type McpOAuthSettings,
	type McpSignInOptions,
	type McpSignInRedirect,
	type OAuthCallbackPage,
	type OAuthCallbackServer,
	type OAuthChallenge,
	responseFromRedirectUrl,
	startMcpSignIn,
} from "@earendil-works/pi-mcp/oauth";
import { PluginError } from "@p2/app/v1";
import { expandHostVariables } from "./config.ts";
import type { McpCredentials } from "./credentials.ts";
import { resultPage } from "./pages.ts";

/** An HTTP server that signs in with OAuth: its name, URL and the client settings of its `oauth` entry. */
export type OAuthServer = { readonly name: string; readonly url: string; readonly config: McpOAuthConfig | undefined };

/** Where a sign-in's browser step returns: a loopback callback on the p2 host, or p2's callback route at `url`. */
export type SignInRedirect = { readonly kind: "loopback" } | { readonly kind: "route"; readonly url: string };

/** A begun sign-in: signed in at once (a stored refresh token worked), or the authorization URL to open. */
export type SignInStart = { readonly kind: "authorized" } | { readonly kind: "redirect"; readonly url: string };

/** A sign-in as the owner sees it: no URL, state or code. */
export type SignInView = {
	readonly id: string;
	readonly server: string;
	readonly via: "loopback" | "route";
	readonly status: "waiting" | "failed";
	readonly error?: string;
};

/** What the sign-ins do once a server's credentials changed (signed in or out): reconnect its instances. */
export type CredentialsChanged = (server: string) => void;

/** How long a sign-in waits for its browser step. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/**
 * pi's Client ID Metadata Documents on pi.dev: they list the loopback redirect URIs `http://127.0.0.1/callback` and
 * `http://localhost/callback` (any port), so loopback sign-ins may use them; p2's https callback route registers
 * dynamically.
 */
const PI_CLIENT_METADATA_DOCUMENTS: McpClientMetadataDocuments = {
	baseUrl: "https://pi.dev/oauth",
	listsRedirectUrl: (redirectUrl) => {
		const url = new URL(redirectUrl);
		return (
			url.protocol === "http:" &&
			(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
			url.pathname === "/callback"
		);
	},
};

/** One sign-in under way (or failed, kept for the owner to see until replaced or dismissed). */
type Flow = {
	readonly id: string;
	readonly server: OAuthServer;
	readonly options: McpSignInOptions;
	readonly authorization: McpSignInRedirect;
	readonly callback: OAuthCallbackServer | undefined;
	readonly timer: ReturnType<typeof setTimeout>;
	status: "waiting" | "completing" | "failed";
	error?: string;
};

/** The auth providers and sign-in flows; subscribers hear of every change of `list`. */
export class SignIns {
	readonly #credentials: McpCredentials;
	readonly #clientName: string;
	readonly #changed: CredentialsChanged;
	readonly #timeoutMs: number;
	/** The last challenge of each server's connections (its resource metadata URL and scope), by server key. */
	readonly #challenges = new Map<string, OAuthChallenge>();
	/** The current flow of each server, by name. */
	readonly #flows = new Map<string, Flow>();
	readonly #listeners = new Set<() => void>();

	constructor(credentials: McpCredentials, clientName: string, changed: CredentialsChanged, timeoutMs: number) {
		this.#credentials = credentials;
		this.#clientName = clientName;
		this.#changed = changed;
		this.#timeoutMs = timeoutMs;
	}

	/** `listener` is called after every change of `list`; the result stops it. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The flows, by server. */
	list(): SignInView[] {
		return [...this.#flows.values()]
			.map((flow) => ({
				id: flow.id,
				server: flow.server.name,
				via: flow.callback === undefined ? ("route" as const) : ("loopback" as const),
				// Completing is still waiting to the owner: a paste meanwhile is refused as for any finished flow.
				status: flow.status === "failed" ? ("failed" as const) : ("waiting" as const),
				...(flow.error === undefined ? {} : { error: flow.error }),
			}))
			.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
	}

	/** The auth provider of `server`'s connections: stored tokens, refreshed; never a browser step. */
	authProvider(server: OAuthServer): McpAuthProvider {
		return createMcpAuthProvider({
			serverUrl: server.url,
			store: this.#credentials.forServer(server.name, server.url),
			settings: () => settingsOf(server.config),
			onChallenge: (challenge) => this.#challenges.set(keyOf(server), challenge),
			clientName: this.#clientName,
			clientMetadataDocuments: PI_CLIENT_METADATA_DOCUMENTS,
		});
	}

	/**
	 * Begins a sign-in to `server`, replacing its current one. A pre-registered client (`oauth.clientId`) always uses the
	 * loopback callback: its redirect URIs are registered as configured.
	 */
	async begin(server: OAuthServer, redirect: SignInRedirect): Promise<SignInStart> {
		const settings = settingsOf(server.config);
		const store = this.#credentials.forServer(server.name, server.url);
		const listening =
			redirect.kind === "route" && settings.clientId === undefined
				? { redirectUrl: redirect.url, callback: undefined }
				: await listenForLoopbackSignIn({
						serverUrl: server.url,
						store,
						settings,
						clientMetadataDocuments: PI_CLIENT_METADATA_DOCUMENTS,
						renderPage: (page) => callbackPage(server.name, page),
					});
		const options: McpSignInOptions = {
			serverUrl: server.url,
			store,
			settings,
			redirectUrl: listening.redirectUrl,
			challenge: this.#challenges.get(keyOf(server)),
			clientName: this.#clientName,
			clientMetadataDocuments: PI_CLIENT_METADATA_DOCUMENTS,
		};
		let start: Awaited<ReturnType<typeof startMcpSignIn>>;
		try {
			start = await startMcpSignIn(options);
		} catch (error) {
			await listening.callback?.close().catch(() => {});
			throw error;
		}
		const previous = this.#flows.get(server.name);
		if (previous !== undefined) this.#drop(previous);
		if (start.kind === "authorized") {
			await listening.callback?.close().catch(() => {});
			this.#notify();
			this.#changed(server.name);
			return { kind: "authorized" };
		}
		const flow: Flow = {
			id: randomUUID(),
			server,
			options,
			authorization: start,
			callback: listening.callback,
			timer: setTimeout(() => this.#fail(flow, new Error("The sign-in expired; start it again")), this.#timeoutMs),
			status: "waiting",
		};
		flow.timer.unref();
		this.#flows.set(server.name, flow);
		flow.callback
			?.waitForCallback(start.state, new URL(start.redirectUrl).pathname)
			.then(
				(response) => this.#finish(flow, response),
				(error: unknown) => this.#fail(flow, error),
			)
			.catch(() => {});
		this.#notify();
		return { kind: "redirect", url: start.authorizationUrl };
	}

	/**
	 * Completes the route sign-in whose `state` the authorization response carries (an error response fails it); the
	 * result names its server.
	 */
	async complete(
		response: { state: string } & ({ code: string; iss?: string } | { error: string }),
	): Promise<{ server: string }> {
		const flow = [...this.#flows.values()].find(
			(candidate) =>
				candidate.callback === undefined &&
				candidate.status === "waiting" &&
				candidate.authorization.state === response.state,
		);
		if (flow === undefined) throw new PluginError("not_found", "This sign-in is unknown, finished or expired");
		if ("error" in response) {
			this.#fail(flow, new Error(response.error));
			throw new PluginError("sign_in", response.error);
		}
		await this.#finish(flow, {
			code: response.code,
			state: response.state,
			...(response.iss ? { iss: response.iss } : {}),
		});
		return { server: flow.server.name };
	}

	/** Completes sign-in `id` with the final redirect URL the owner copied from the browser. */
	async paste(id: string, redirectUrl: string): Promise<void> {
		const flow = this.#byId(id);
		if (flow?.status !== "waiting")
			throw new PluginError("not_found", "This sign-in is unknown, finished or expired");
		// A URL of another sign-in or no code is refused without failing this one.
		let response: McpAuthorizationResponse;
		try {
			response = responseFromRedirectUrl(redirectUrl, flow.authorization);
		} catch (error) {
			throw new PluginError("invalid_url", messageOf(error));
		}
		await this.#finish(flow, response);
	}

	/** Ends sign-in `id`, under way or failed. */
	cancel(id: string): void {
		const flow = this.#byId(id);
		if (flow === undefined) return;
		this.#drop(flow);
		this.#notify();
	}

	/** Forgets `server`'s credentials and ends its sign-in; its instances reconnect, without them. */
	async signOut(server: OAuthServer): Promise<void> {
		const flow = this.#flows.get(server.name);
		if (flow !== undefined) {
			this.#drop(flow);
			this.#notify();
		}
		await this.#credentials.remove(server.name, server.url);
		this.#changed(server.name);
	}

	/** Ends every flow (their loopback servers close). */
	async close(): Promise<void> {
		const flows = [...this.#flows.values()];
		this.#flows.clear();
		await Promise.allSettled(
			flows.map((flow) => {
				clearTimeout(flow.timer);
				return flow.callback?.close();
			}),
		);
		await this.#credentials.close();
	}

	#byId(id: string): Flow | undefined {
		return [...this.#flows.values()].find((flow) => flow.id === id);
	}

	/** Exchanges the code of `response`; a failure fails the flow and is thrown. */
	async #finish(flow: Flow, response: McpAuthorizationResponse): Promise<void> {
		if (flow.status !== "waiting" || this.#flows.get(flow.server.name) !== flow)
			throw new PluginError("not_found", "This sign-in is unknown, finished or expired");
		flow.status = "completing";
		try {
			await completeMcpSignIn({ ...flow.options, authorization: flow.authorization, response });
		} catch (error) {
			this.#fail(flow, error);
			throw new PluginError("sign_in", messageOf(error));
		}
		if (this.#flows.get(flow.server.name) === flow) {
			this.#drop(flow);
			this.#notify();
		}
		this.#changed(flow.server.name);
	}

	/** Marks `flow` failed (if it is still the server's current one and has not finished). */
	#fail(flow: Flow, error: unknown): void {
		if (this.#flows.get(flow.server.name) !== flow || flow.status === "failed") return;
		flow.status = "failed";
		flow.error = messageOf(error);
		clearTimeout(flow.timer);
		void flow.callback?.close().catch(() => {});
		this.#notify();
	}

	/** Removes `flow`: its timer stops and its loopback server closes. */
	#drop(flow: Flow): void {
		if (this.#flows.get(flow.server.name) === flow) this.#flows.delete(flow.server.name);
		clearTimeout(flow.timer);
		void flow.callback?.close().catch(() => {});
	}

	#notify(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}

/** The settings of an `oauth` entry: `${NAME}` in the client secret from the p2 host's environment. */
function settingsOf(config: McpOAuthConfig | undefined): McpOAuthSettings {
	if (config === undefined) return {};
	return {
		clientId: config.clientId,
		clientSecret: config.clientSecret === undefined ? undefined : expandHostVariables(config.clientSecret),
		callbackPort: config.callbackPort,
		callbackUrl: config.callbackUrl,
		scope: config.scope,
		clientName: config.clientName,
		clientRegistration: config.clientRegistration,
		authServerMetadataUrl: config.authServerMetadataUrl ? new URL(config.authServerMetadataUrl) : undefined,
	};
}

/** A server's key for its challenges: its name and URL, as its credentials'. */
function keyOf(server: OAuthServer): string {
	return JSON.stringify([server.name, server.url]);
}

/** The loopback callback's page after the redirect. */
function callbackPage(server: string, page: OAuthCallbackPage): string {
	return page.ok
		? resultPage(`Signed in to ${server}`, "You may close this page.")
		: resultPage(`Signing in to ${server} failed`, page.details ? `${page.message} ${page.details}` : page.message);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
