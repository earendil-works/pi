import { afterEach, describe, expect, it } from "vitest";
import {
	completeMcpSignIn,
	createMcpAuthProvider,
	type McpAuthorizationResponse,
	McpOAuthAuthorizationRequiredError,
	type McpSignInOptions,
	type McpSignInRedirect,
	startMcpSignIn,
} from "../src/oauth/index.ts";
import {
	type AuthorizationServer,
	authorizeInBrowser,
	memoryStore,
	startAuthorizationServer,
} from "./authorization-server.ts";
import { closeServers } from "./helpers.ts";

afterEach(closeServers);

const ROUTE = "https://app.example/mcp/callback";
const LOOPBACK = "http://127.0.0.1:1/callback";

async function startRedirect(options: McpSignInOptions): Promise<McpSignInRedirect> {
	const started = await startMcpSignIn(options);
	if (started.kind !== "redirect") throw new Error("Expected the browser step");
	return started;
}

async function browse(authorization: McpSignInRedirect): Promise<McpAuthorizationResponse> {
	const query = new URL(await authorizeInBrowser(authorization.authorizationUrl)).searchParams;
	const iss = query.get("iss");
	return { code: query.get("code") ?? "", state: query.get("state") ?? "", ...(iss ? { iss } : {}) };
}

async function signIn(options: McpSignInOptions): Promise<void> {
	const authorization = await startRedirect(options);
	await completeMcpSignIn({ ...options, authorization, response: await browse(authorization) });
}

/** What a connection's request reports after its token was rejected. */
function unauthorized(server: AuthorizationServer, token: string) {
	return { response: new Response(null, { status: 401 }), serverUrl: new URL(server.serverUrl), fetch, token };
}

describe("createMcpAuthProvider", () => {
	it("refreshes a rejected token", async () => {
		const server = await startAuthorizationServer();
		const options = { serverUrl: server.serverUrl, store: memoryStore(), redirectUrl: ROUTE, clientName: "app" };
		await signIn({ ...options, settings: {} });
		const provider = createMcpAuthProvider({ ...options, settings: () => ({}), onChallenge: () => {} });

		await provider.onUnauthorized?.(unauthorized(server, "access-1"));
		expect(await provider.token()).toBe("access-2");
		expect(server.tokenRequests[1].get("client_id")).toBe("client-1");
	});

	it("leaves a pending sign-in usable when the refresh fails", async () => {
		const server = await startAuthorizationServer();
		const options = { serverUrl: server.serverUrl, store: memoryStore(), redirectUrl: ROUTE, clientName: "app" };
		await signIn({ ...options, settings: {} });
		// A step-up keeps the tokens while the user is in the browser.
		const stepUp = { ...options, settings: {}, challenge: { error: "insufficient_scope", scope: "more" } };
		const authorization = await startRedirect(stepUp);
		const pending = await options.store.load();

		server.revokeRefreshTokens();
		const provider = createMcpAuthProvider({ ...options, settings: () => ({}), onChallenge: () => {} });
		await expect(provider.onUnauthorized?.(unauthorized(server, "access-1"))).rejects.toBeInstanceOf(
			McpOAuthAuthorizationRequiredError,
		);

		const state = await options.store.load();
		expect(state?.oauthState).toBe(pending?.oauthState);
		expect(state?.codeVerifier).toBe(pending?.codeVerifier);
		expect(server.registrations).toHaveLength(1);
		await completeMcpSignIn({ ...stepUp, authorization, response: await browse(authorization) });
		expect((await options.store.load())?.tokens?.access_token).toBe("access-2");
	});

	it("does not register a client to refresh", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const options = { serverUrl: server.serverUrl, store: memoryStore(), redirectUrl: LOOPBACK, clientName: "app" };
		const clientMetadataDocuments = { baseUrl: "https://app.example/oauth", listsRedirectUrl: () => true };
		await signIn({ ...options, settings: {}, clientMetadataDocuments });
		expect((await options.store.load())?.clientInformation).toBeUndefined();

		// Without the documents, the tokens have no client to refresh them with.
		const provider = createMcpAuthProvider({ ...options, settings: () => ({}), onChallenge: () => {} });
		await expect(provider.onUnauthorized?.(unauthorized(server, "access-1"))).rejects.toBeInstanceOf(
			McpOAuthAuthorizationRequiredError,
		);
		expect(server.registrations).toEqual([]);
		expect(server.authorizations).toHaveLength(1);
	});

	it.each(["auto", "cimd"] as const)(
		"refreshes the tokens of a document that lists only the redirect URI passed (%s)",
		async (clientRegistration) => {
			const server = await startAuthorizationServer({ cimd: true, issParameter: true });
			const options = { serverUrl: server.serverUrl, store: memoryStore(), redirectUrl: ROUTE, clientName: "app" };
			const clientMetadataDocuments = {
				baseUrl: "https://app.example/oauth",
				listsRedirectUrl: (redirectUrl: string) => redirectUrl === ROUTE,
			};
			const settings = { clientRegistration };
			await signIn({ ...options, settings, clientMetadataDocuments });
			expect((await options.store.load())?.clientInformation).toBeUndefined();

			const provider = createMcpAuthProvider({
				...options,
				clientMetadataDocuments,
				settings: () => settings,
				onChallenge: () => {},
			});
			await provider.onUnauthorized?.(unauthorized(server, "access-1"));
			expect(await provider.token()).toBe("access-2");
			expect(server.tokenRequests[1].get("client_id")).toBe("https://app.example/oauth/client.json");
			expect(server.authorizations).toHaveLength(1);
		},
	);

	/** Signed in, with a step-up sign-in waiting for the browser, which keeps the tokens meanwhile. */
	async function pendingSignIn() {
		const server = await startAuthorizationServer();
		const options = { serverUrl: server.serverUrl, store: memoryStore(), redirectUrl: ROUTE, clientName: "app" };
		await signIn({ ...options, settings: {} });
		const stepUp = { ...options, settings: {}, challenge: { error: "insufficient_scope", scope: "more" } };
		const authorization = await startRedirect(stepUp);
		const pending = await options.store.load();
		const provider = createMcpAuthProvider({ ...options, settings: () => ({}), onChallenge: () => {} });
		return { server, store: options.store, stepUp, authorization, pending, provider };
	}

	it("drops a rejected client and its tokens but keeps the pending sign-in", async () => {
		const { server, store, pending, provider } = await pendingSignIn();
		server.failNextRefresh("invalid_client");
		await expect(provider.onUnauthorized?.(unauthorized(server, "access-1"))).rejects.toBeInstanceOf(
			McpOAuthAuthorizationRequiredError,
		);
		const state = await store.load();
		expect(state?.oauthState).toBe(pending?.oauthState);
		expect(state?.codeVerifier).toBe(pending?.codeVerifier);
		expect(state?.clientInformation).toBeUndefined();
		expect(state?.tokens).toBeUndefined();
		expect(server.registrations).toHaveLength(1);
	});

	it("keeps a client stored while the rejected refresh ran", async () => {
		const { server, store, provider } = await pendingSignIn();
		// Another sign-in completes with a new client while the server rejects the old one.
		server.failNextRefresh("invalid_client", async () => {
			const state = await store.load();
			if (state)
				await store.save({ ...state, clientInformation: { client_id: "client-new", redirect_uris: [ROUTE] } });
		});
		await provider.onUnauthorized?.(unauthorized(server, "access-1"));
		expect((await store.load())?.clientInformation?.client_id).toBe("client-new");
		expect(server.tokenRequests.at(-1)?.get("client_id")).toBe("client-new");
		expect(await provider.token()).toBe("access-2");
	});

	it("keeps the tokens and the pending sign-in after a server error", async () => {
		const { server, store, pending, provider } = await pendingSignIn();
		server.failNextRefresh("server_error");
		await expect(provider.onUnauthorized?.(unauthorized(server, "access-1"))).rejects.toBeInstanceOf(
			McpOAuthAuthorizationRequiredError,
		);
		const state = await store.load();
		expect(state?.oauthState).toBe(pending?.oauthState);
		expect(state?.codeVerifier).toBe(pending?.codeVerifier);
		expect(state?.tokens?.access_token).toBe("access-1");
	});

	it("keeps the tokens and the pending sign-in after a network error", async () => {
		const { server, store, pending, provider } = await pendingSignIn();
		const offline: typeof fetch = (input, init) =>
			String(input).endsWith("/token") ? Promise.reject(new TypeError("fetch failed")) : fetch(input, init);
		await expect(
			provider.onUnauthorized?.({ ...unauthorized(server, "access-1"), fetch: offline }),
		).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		const state = await store.load();
		expect(state?.oauthState).toBe(pending?.oauthState);
		expect(state?.codeVerifier).toBe(pending?.codeVerifier);
		expect(state?.tokens?.access_token).toBe("access-1");
	});
});
