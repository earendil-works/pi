import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";

// Browsers cannot start a local server; this file runs the sign-in as a browser would.
vi.mock("../src/auth/oauth/callback-server.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	loadCreateServer: async () => undefined,
}));

const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

describe("OpenAI ChatGPT OAuth without a local server", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("completes with the pasted redirect address", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "access",
							refresh_token: "refresh",
							expires_in: 3600,
							id_token: "id",
							scope: SCOPE,
						}),
						{ headers: { "content-type": "application/json" } },
					),
			),
		);
		let authorizeUrl: URL | undefined;
		const credential = await openaiChatGPTOAuth.login(
			{
				signal: new AbortController().signal,
				notify: (event) => {
					if (event.type === "auth_url") authorizeUrl = new URL(event.url);
				},
				prompt: async () => {
					const callback = new URL(authorizeUrl?.searchParams.get("redirect_uri") ?? "");
					callback.searchParams.set("code", "code");
					callback.searchParams.set("state", authorizeUrl?.searchParams.get("state") ?? "");
					callback.searchParams.set("client_id", "oaiapp_issued");
					return callback.toString();
				},
			},
			{ getDeviceId: () => "e61bbe28-07ef-466d-8e5d-a344f94ab305" },
		);
		expect(credential).toMatchObject({ access: "access", refresh: "refresh", clientId: "oaiapp_issued" });
	});
});
