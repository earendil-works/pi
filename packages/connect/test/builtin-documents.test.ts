import type { AuthPrompt, OAuthAuth } from "@earendil-works/pi-ai";
import { getBuiltinOAuthFlow } from "@earendil-works/pi-ai/oauth-flows";
import { describe, expect, it } from "vitest";
import { BUILTIN_AUTH_DOCUMENTS } from "../src/builtin-documents.ts";
import { RELAY_ENDPOINTS } from "../src/relay.ts";

const oauthMethods = BUILTIN_AUTH_DOCUMENTS.providers.flatMap((document) =>
	document.methods.filter((method) => method.type === "oauth").map((method) => ({ document, method })),
);

describe("BUILTIN_AUTH_DOCUMENTS", () => {
	it("explains every method that is not plain direct", () => {
		for (const document of BUILTIN_AUTH_DOCUMENTS.providers) {
			if (document.inference.browser === "unsupported") expect(document.inference.reason).toBeTruthy();
			for (const method of document.methods) {
				if (method.browser.signIn !== "direct" || method.browser.relay !== "none") {
					expect(method.browser.reason, `${document.provider}/${method.id}`).toBeTruthy();
				}
			}
		}
	});

	it("relays exactly the providers whose methods need the relay", () => {
		const relayed = new Set(
			oauthMethods
				.filter(({ method }) => method.browser.relay !== "none" && method.browser.signIn !== "unsupported")
				.map(({ document }) => document.provider),
		);
		expect(new Set(RELAY_ENDPOINTS.map((endpoint) => endpoint.provider))).toEqual(relayed);
	});

	it("names a pi-ai flow for every OAuth method", () => {
		for (const { document } of oauthMethods)
			expect(getBuiltinOAuthFlow(document.provider), document.provider).toBeDefined();
	});

	it("uses the method IDs the flows offer in their selection", async () => {
		// Flows with one method ignore the ID; flows with several start with a selection.
		const multiMethod = oauthMethods.filter(
			({ document }) => oauthMethods.filter((entry) => entry.document === document).length > 1,
		);
		expect(multiMethod.length).toBeGreaterThan(0);
		for (const { document, method } of multiMethod) {
			const offered = await selectionOffered(getBuiltinOAuthFlow(document.provider) as OAuthAuth);
			expect(offered, `${document.provider}/${method.id}`).toContain(method.id);
		}
	});
});

/** The option IDs of the flow's first prompt when it is a selection; the login stops at that prompt. */
async function selectionOffered(flow: OAuthAuth): Promise<string[] | undefined> {
	let first: AuthPrompt | undefined;
	await flow
		.login(
			{
				signal: new AbortController().signal,
				prompt: async (prompt) => {
					first ??= prompt;
					throw new Error("stop");
				},
				notify: () => {},
			},
			{ getDeviceId: () => "00000000-0000-4000-8000-000000000000" },
		)
		.catch(() => undefined);
	return first?.type === "select" ? first.options.map((option) => option.id) : undefined;
}
