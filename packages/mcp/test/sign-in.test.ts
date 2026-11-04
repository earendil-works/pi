import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	completeMcpSignIn,
	type McpAuthorizationResponse,
	type McpClientMetadataDocuments,
	type McpOAuthSettings,
	McpRefreshLockBusyError,
	McpSignInCancelledError,
	type McpSignInOptions,
	type McpSignInRedirect,
	startMcpSignIn,
} from "../src/oauth/index.ts";
import {
	type AuthorizationServer,
	authorizeInBrowser,
	memoryStore,
	recordingStore,
	startAuthorizationServer,
} from "./authorization-server.ts";
import { closeServers } from "./helpers.ts";

afterEach(closeServers);

/** Callback routes of the application on two origins, like p2 through a relay and on its public URL. */
const ROUTE = "https://app.example/mcp/callback";
const OTHER_ROUTE = "https://relay.example/mcp/callback";
/** A loopback redirect URI; tests read the redirect from the authorization server instead of following it. */
const LOOPBACK = "http://127.0.0.1:1/callback";

/** Documents that list `/callback` on 127.0.0.1, like pi's on pi.dev. */
const documents: McpClientMetadataDocuments = {
	baseUrl: "https://app.example/oauth",
	listsRedirectUrl: (redirectUrl) => {
		const url = new URL(redirectUrl);
		return url.hostname === "127.0.0.1" && url.pathname === "/callback";
	},
};

function signInOptions(
	server: AuthorizationServer,
	options: Partial<McpSignInOptions> = {},
	settings: McpOAuthSettings = {},
): McpSignInOptions {
	return {
		serverUrl: server.serverUrl,
		store: memoryStore(),
		settings,
		redirectUrl: ROUTE,
		clientName: "app",
		...options,
	};
}

async function startRedirect(options: McpSignInOptions): Promise<McpSignInRedirect> {
	const started = await startMcpSignIn(options);
	if (started.kind !== "redirect") throw new Error("Expected the browser step");
	return started;
}

/** The response a callback route reads from the query of the redirect. */
function routeResponse(location: string): McpAuthorizationResponse {
	const query = new URL(location).searchParams;
	const iss = query.get("iss");
	return { code: query.get("code") ?? "", state: query.get("state") ?? "", ...(iss ? { iss } : {}) };
}

/** Start, follow the browser step, and complete. */
async function signIn(options: McpSignInOptions): Promise<McpSignInRedirect> {
	const authorization = await startRedirect(options);
	const response = routeResponse(await authorizeInBrowser(authorization.authorizationUrl));
	await completeMcpSignIn({ ...options, authorization, response });
	return authorization;
}

describe("start and complete", () => {
	it("completes in a second call with the same store and a persisted redirect", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server, {}, { scope: "issues:read" });

		const started = await startRedirect(options);
		// Plain data: the application may store it and read it back in another request.
		const authorization = JSON.parse(JSON.stringify(started)) as McpSignInRedirect;
		expect(authorization).toEqual(started);
		expect(authorization).toMatchObject({ redirectUrl: ROUTE, scope: "issues:read" });
		expect(new URL(authorization.authorizationUrl).searchParams.get("state")).toBe(authorization.state);
		expect(server.registrations).toMatchObject([
			{ client_name: "app", redirect_uris: [ROUTE], application_type: "web" },
		]);

		const response = routeResponse(await authorizeInBrowser(authorization.authorizationUrl));
		await completeMcpSignIn({ ...options, authorization, response });

		expect((await options.store.load())?.tokens).toMatchObject({ access_token: "access-1", scope: "issues:read" });
		expect(server.tokenRequests[0].get("redirect_uri")).toBe(ROUTE);
		expect(server.tokenRequests[0].get("client_id")).toBe("client-1");
	});

	it("refreshes the stored tokens instead of redirecting", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server);
		await signIn(options);

		expect(await startMcpSignIn(options)).toEqual({ kind: "authorized" });
		expect(server.authorizations).toHaveLength(1);
		expect(server.tokenRequests[1].get("grant_type")).toBe("refresh_token");
		expect((await options.store.load())?.tokens?.access_token).toBe("access-2");
	});

	it("refreshes under the store's refresh lock", async () => {
		const server = await startAuthorizationServer();
		const { store, saves } = recordingStore();
		const options = signInOptions(server, { store });
		await signIn(options);

		expect(await startMcpSignIn(options)).toEqual({ kind: "authorized" });
		expect(saves.filter((save) => save.accessToken === "access-2")).toEqual([
			{ locked: true, accessToken: "access-2" },
		]);
	});

	it("goes to the browser step when another process holds the refresh lock for too long", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server, {
			store: recordingStore({ lockError: new McpRefreshLockBusyError() }).store,
		});
		await signIn(options);

		expect((await startMcpSignIn(options)).kind).toBe("redirect");
		expect(server.tokenRequests.map((request) => request.get("grant_type"))).toEqual(["authorization_code"]);
	});

	it("fails when the refresh lock fails for another reason", async () => {
		const server = await startAuthorizationServer();
		const lockError = new Error("EACCES: permission denied");
		const options = signInOptions(server, { store: recordingStore({ lockError }).store });

		await expect(startMcpSignIn(options)).rejects.toBe(lockError);
		expect(server.registrations).toEqual([]);
		expect(server.authorizations).toEqual([]);
	});

	it("refuses to complete with another redirect URI than the authorization request", async () => {
		const server = await startAuthorizationServer({ cimd: true });
		const options = signInOptions(server, { redirectUrl: LOOPBACK, clientMetadataDocuments: documents });
		const authorization = await startRedirect(options);
		const response = routeResponse(await authorizeInBrowser(authorization.authorizationUrl));
		// Another loopback port than the one passed to start: the server-specific variant differs too.
		const wrong = { ...options, redirectUrl: "http://127.0.0.1:2/callback" };
		await expect(completeMcpSignIn({ ...wrong, authorization, response })).rejects.toThrow(
			`but the authorization request used ${authorization.redirectUrl}`,
		);
		expect(server.tokenRequests).toEqual([]);
	});

	it("gives every sign-in a fresh state and refuses to complete a superseded one", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server);
		const first = await startRedirect(options);
		const firstResponse = routeResponse(await authorizeInBrowser(first.authorizationUrl));
		const second = await startRedirect(options);
		expect(second.state).not.toBe(first.state);

		await expect(completeMcpSignIn({ ...options, authorization: first, response: firstResponse })).rejects.toThrow(
			"Another sign-in to this MCP server started since",
		);
		expect(server.tokenRequests).toEqual([]);
	});

	it("refuses a response with another state", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server);
		const authorization = await startRedirect(options);
		const response = routeResponse(await authorizeInBrowser(authorization.authorizationUrl));
		await expect(
			completeMcpSignIn({ ...options, authorization, response: { ...response, state: "other" } }),
		).rejects.toThrow("belongs to a different sign-in");
		expect(server.tokenRequests).toEqual([]);
	});
});

describe("stored client", () => {
	it("refreshes with the stored client from another redirect URI", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server);
		await signIn(options);

		expect(await startMcpSignIn({ ...options, redirectUrl: OTHER_ROUTE })).toEqual({ kind: "authorized" });
		expect(server.registrations).toHaveLength(1);
		expect(server.tokenRequests[1].get("client_id")).toBe("client-1");
		expect((await options.store.load())?.clientInformation?.client_id).toBe("client-1");
	});

	it("keeps the client for a browser step on its redirect URI", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server);
		await signIn(options);
		server.revokeRefreshTokens();

		const authorization = await startRedirect(options);
		expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe("client-1");
		expect(server.registrations).toHaveLength(1);
	});

	it("drops the client and its tokens for a browser step on another redirect URI", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server);
		await signIn(options);
		server.revokeRefreshTokens();

		const authorization = await startRedirect({ ...options, redirectUrl: OTHER_ROUTE });
		expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe("client-2");
		expect(server.registrations[1]).toMatchObject({ redirect_uris: [OTHER_ROUTE] });
		const state = await options.store.load();
		expect(state?.clientInformation?.client_id).toBe("client-2");
		expect(state?.tokens).toBeUndefined();
	});

	it("does not refresh with a registered client that cimd replaces", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const options = signInOptions(server, { redirectUrl: LOOPBACK, clientMetadataDocuments: documents });
		await signIn({ ...options, settings: { clientRegistration: "dcr" } });
		expect((await options.store.load())?.clientInformation?.client_id).toBe("client-1");

		const authorization = await startRedirect({ ...options, settings: { clientRegistration: "cimd" } });
		expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe(
			"https://app.example/oauth/client.json",
		);
		expect(server.tokenRequests.map((request) => request.get("grant_type"))).toEqual(["authorization_code"]);
		const state = await options.store.load();
		expect(state?.clientInformation).toBeUndefined();
		expect(state?.tokens).toBeUndefined();
	});

	it("asks for the granted scope plus the challenged one on a step-up, without refreshing", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server, { challenge: { scope: "issues:read" } });
		await signIn(options);
		expect((await options.store.load())?.tokens?.scope).toBe("issues:read");

		// The challenge lists only the missing scope; requesting just that would lose issues:read.
		const stepUp = { ...options, challenge: { error: "insufficient_scope", scope: "issues:write" } };
		const authorization = await signIn(stepUp);
		expect(authorization.scope).toBe("issues:read issues:write");
		expect(server.tokenRequests.map((request) => request.get("grant_type"))).toEqual([
			"authorization_code",
			"authorization_code",
		]);
		expect((await options.store.load())?.tokens?.scope).toBe("issues:read issues:write");
	});
});

describe("client metadata documents", () => {
	const loopback = (server: AuthorizationServer, settings: McpOAuthSettings = {}) =>
		signInOptions(server, { redirectUrl: LOOPBACK, clientMetadataDocuments: documents }, settings);

	it("uses a document when the server supports them and the documents list the redirect URI", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const options = loopback(server);
		const authorization = await signIn(options);
		expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe(
			"https://app.example/oauth/client.json",
		);
		expect(authorization.redirectUrl).toBe(LOOPBACK);
		expect(server.registrations).toEqual([]);
		expect(server.tokenRequests[0].get("client_id")).toBe("https://app.example/oauth/client.json");
		expect((await options.store.load())?.clientInformation).toBeUndefined();
	});

	it("uses a document and redirect URI specific to the MCP server without the iss parameter", async () => {
		const server = await startAuthorizationServer({ cimd: true });
		const authorization = await signIn(loopback(server));
		const id = createHash("sha256").update(server.serverUrl).digest().subarray(0, 9).toString("base64url");
		expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe(
			`https://app.example/oauth/${id}/client.json`,
		);
		expect(authorization.redirectUrl).toBe(`${LOOPBACK}/${id}`);
		expect(server.tokenRequests[0].get("redirect_uri")).toBe(`${LOOPBACK}/${id}`);
	});

	it("appends the server-specific path without doubling a trailing slash", async () => {
		const server = await startAuthorizationServer({ cimd: true });
		const authorization = await startRedirect({
			...loopback(server),
			redirectUrl: `${LOOPBACK}/`,
			clientMetadataDocuments: { ...documents, listsRedirectUrl: () => true },
		});
		const id = createHash("sha256").update(server.serverUrl).digest().subarray(0, 9).toString("base64url");
		expect(authorization.redirectUrl).toBe(`${LOOPBACK}/${id}`);
	});

	it("registers dynamically when the server does not support documents", async () => {
		const server = await startAuthorizationServer({ issParameter: true });
		await signIn(loopback(server));
		expect(server.registrations).toHaveLength(1);
		expect(server.authorizations[0].get("client_id")).toBe("client-1");
	});

	it("registers dynamically when the documents do not list the redirect URI", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		await signIn({ ...loopback(server), redirectUrl: ROUTE });
		expect(server.registrations).toHaveLength(1);
	});

	it("registers dynamically without documents or with a client name", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		await signIn({ ...loopback(server), clientMetadataDocuments: undefined });
		await signIn(loopback(server, { clientName: "Other" }));
		expect(server.registrations).toMatchObject([{ client_name: "app" }, { client_name: "Other" }]);
	});

	/** Documents that list only the application's https callback route. */
	const routeDocuments: McpClientMetadataDocuments = {
		baseUrl: "https://app.example/oauth",
		listsRedirectUrl: (redirectUrl) => redirectUrl === ROUTE,
	};

	it.each(["auto", "cimd"] as const)(
		"refreshes the tokens of a document that lists only an https route (%s)",
		async (clientRegistration) => {
			const server = await startAuthorizationServer({ cimd: true, issParameter: true });
			const options = signInOptions(server, { clientMetadataDocuments: routeDocuments }, { clientRegistration });
			const authorization = await signIn(options);
			expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe(
				"https://app.example/oauth/client.json",
			);
			expect((await options.store.load())?.clientInformation).toBeUndefined();

			expect(await startMcpSignIn(options)).toEqual({ kind: "authorized" });
			expect(server.authorizations).toHaveLength(1);
			expect(server.tokenRequests[1].get("grant_type")).toBe("refresh_token");
			expect(server.tokenRequests[1].get("client_id")).toBe("https://app.example/oauth/client.json");
			expect((await options.store.load())?.tokens?.access_token).toBe("access-2");
		},
	);

	it("fails with cimd when the server does not support documents", async () => {
		const server = await startAuthorizationServer({ issParameter: true });
		await expect(startMcpSignIn(loopback(server, { clientRegistration: "cimd" }))).rejects.toThrow(
			"does not support Client ID Metadata Documents",
		);
		expect(server.registrations).toEqual([]);
	});

	it("fails with cimd when the documents do not list the redirect URI", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const options = { ...loopback(server, { clientRegistration: "cimd" }), redirectUrl: ROUTE };
		await expect(startMcpSignIn(options)).rejects.toThrow(
			"needs Client ID Metadata Documents that list the redirect URI",
		);
		expect(server.registrations).toEqual([]);
	});
});

describe("cancellation", () => {
	it("cancels a start whose request does not answer", async () => {
		const server = await startAuthorizationServer();
		server.stall.add("/register");
		const controller = new AbortController();
		const started = startMcpSignIn({ ...signInOptions(server), signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await expect(started).rejects.toBeInstanceOf(McpSignInCancelledError);
	});

	it("cancels a completion whose token request does not answer", async () => {
		const server = await startAuthorizationServer();
		const options = signInOptions(server);
		const authorization = await startRedirect(options);
		const response = routeResponse(await authorizeInBrowser(authorization.authorizationUrl));
		server.stall.add("/token");
		const controller = new AbortController();
		const completed = completeMcpSignIn({ ...options, authorization, response, signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await expect(completed).rejects.toBeInstanceOf(McpSignInCancelledError);
	});

	it("cancels at once while another process holds the refresh lock, and refreshes nothing", async () => {
		const server = await startAuthorizationServer();
		const recording = recordingStore();
		const options = signInOptions(server, { store: recording.store });
		await signIn(options);

		const release = recording.hold();
		const controller = new AbortController();
		const started = startMcpSignIn({ ...options, signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await expect(started).rejects.toBeInstanceOf(McpSignInCancelledError);

		// The lock arrives after the cancellation: nothing runs under it, and it is released.
		release();
		await Promise.all(recording.lockRuns);
		expect(recording.isLocked()).toBe(false);
		expect(server.tokenRequests.map((request) => request.get("grant_type"))).toEqual(["authorization_code"]);
		expect(server.authorizations).toHaveLength(1);
	});

	it("fails at once with an aborted signal", async () => {
		const server = await startAuthorizationServer();
		await expect(startMcpSignIn({ ...signInOptions(server), signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
			McpSignInCancelledError,
		);
		expect(server.registrations).toEqual([]);
	});
});
