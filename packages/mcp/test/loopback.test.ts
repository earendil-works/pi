import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	completeMcpSignIn,
	listenForLoopbackSignIn,
	type McpLoopbackCallback,
	McpSignInCancelledError,
	type McpSignInRedirect,
	responseFromRedirectUrl,
	startMcpSignIn,
	waitForLoopbackSignIn,
} from "../src/oauth/index.ts";
import { authorizeInBrowser, memoryStore, startAuthorizationServer } from "./authorization-server.ts";
import { closeServers } from "./helpers.ts";

const callbacks: McpLoopbackCallback[] = [];

afterEach(async () => {
	await Promise.all(callbacks.splice(0).map(({ callback }) => callback.close()));
	await closeServers();
});

async function listenAt(serverUrl: string, options: { documents?: boolean } = {}): Promise<McpLoopbackCallback> {
	const loopback = await listenForLoopbackSignIn({
		serverUrl,
		store: memoryStore(),
		settings: {},
		...(options.documents
			? { clientMetadataDocuments: { baseUrl: "https://app.example/oauth", listsRedirectUrl: () => true } }
			: {}),
	});
	callbacks.push(loopback);
	return loopback;
}

function pending(redirectUrl: string): McpSignInRedirect {
	return { kind: "redirect", authorizationUrl: "https://auth.example/authorize", redirectUrl, state: "state-1" };
}

describe("loopback sign-in", () => {
	it("completes through the loopback callback server", async () => {
		const server = await startAuthorizationServer();
		const store = memoryStore();
		const loopback = await listenForLoopbackSignIn({ serverUrl: server.serverUrl, store, settings: {} });
		callbacks.push(loopback);
		const { callback, redirectUrl } = loopback;
		expect(redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

		const options = { serverUrl: server.serverUrl, store, settings: {}, redirectUrl, clientName: "app" };
		const authorization = await startMcpSignIn(options);
		if (authorization.kind !== "redirect") throw new Error("Expected the browser step");
		const response = waitForLoopbackSignIn({ callback, authorization });
		await fetch(await authorizeInBrowser(authorization.authorizationUrl));
		await completeMcpSignIn({ ...options, authorization, response: await response });

		expect((await store.load())?.tokens?.access_token).toBe("access-1");
		expect(server.registrations).toMatchObject([{ redirect_uris: [redirectUrl], application_type: "native" }]);
	});

	it("rejects a response on another redirect path", async () => {
		const serverUrl = "https://mcp.example/mcp";
		const { callback, redirectUrl } = await listenAt(serverUrl, { documents: true });
		const id = createHash("sha256").update(serverUrl).digest().subarray(0, 9).toString("base64url");
		const rejected = expect(
			waitForLoopbackSignIn({ callback, authorization: pending(`${redirectUrl}/${id}`) }),
		).rejects.toThrow("arrived on another redirect URI");
		// A mixed-up authorization server redirects to the shared callback path.
		await fetch(`${redirectUrl}?code=c&state=state-1`);
		await rejected;
	});

	it("takes a pasted redirect URL while waiting for the callback", async () => {
		const { callback, redirectUrl } = await listenAt("https://mcp.example/mcp");
		const response = await waitForLoopbackSignIn({
			callback,
			authorization: pending(redirectUrl),
			promptForRedirectUrl: async () => `${redirectUrl}?code=pasted&state=state-1`,
		});
		expect(response).toEqual({ code: "pasted", state: "state-1" });
	});

	it("cancels the wait, and an empty paste cancels too", async () => {
		const { callback, redirectUrl } = await listenAt("https://mcp.example/mcp");
		const controller = new AbortController();
		const waiting = waitForLoopbackSignIn({
			callback,
			authorization: pending(redirectUrl),
			signal: controller.signal,
		});
		controller.abort();
		await expect(waiting).rejects.toBeInstanceOf(McpSignInCancelledError);

		const pasted = waitForLoopbackSignIn({
			callback,
			authorization: { ...pending(redirectUrl), state: "state-2" },
			promptForRedirectUrl: async () => "",
		});
		await expect(pasted).rejects.toBeInstanceOf(McpSignInCancelledError);
	});
});

describe("pasted redirect URLs", () => {
	const authorization = pending("http://127.0.0.1:1234/callback/server-id");
	const redirectUrl = authorization.redirectUrl;

	it("reads the code, state, and issuer", () => {
		expect(responseFromRedirectUrl(` ${redirectUrl}?code=c&state=state-1&iss=x `, authorization)).toEqual({
			code: "c",
			state: "state-1",
			iss: "x",
		});
	});

	it("rejects another state, another redirect path, and errors", () => {
		expect(() => responseFromRedirectUrl(`${redirectUrl}?code=c&state=other`, authorization)).toThrow(
			"belongs to a different sign-in",
		);
		expect(() =>
			responseFromRedirectUrl("http://127.0.0.1:1234/callback?code=c&state=state-1", authorization),
		).toThrow("does not match this sign-in's redirect URI");
		expect(() => responseFromRedirectUrl(`${redirectUrl}?error=access_denied`, authorization)).toThrow(
			"access_denied",
		);
		expect(() => responseFromRedirectUrl("code=c", authorization)).toThrow("Expected the full redirect URL");
	});
});
