import { afterEach, describe, expect, it, vi } from "vitest";
import { findRelayEndpoint, RELAY_ENDPOINTS, relayFetch } from "../src/relay.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("findRelayEndpoint", () => {
	it("matches the exact URL and method only", () => {
		const token = new URL("https://platform.claude.com/v1/oauth/token");
		expect(findRelayEndpoint(token, "post")?.provider).toBe("anthropic");
		expect(findRelayEndpoint(token, "GET")).toBeUndefined();
		expect(findRelayEndpoint(new URL("https://platform.claude.com/v1/oauth/token?x=1"), "POST")).toBeUndefined();
		expect(findRelayEndpoint(new URL("https://platform.claude.com/v1/oauth/tokens"), "POST")).toBeUndefined();
	});

	it("lists every endpoint as an exact https URL", () => {
		for (const endpoint of RELAY_ENDPOINTS) {
			const url = new URL(endpoint.url);
			expect(url.protocol).toBe("https:");
			expect(`${url.origin}${url.pathname}`).toBe(endpoint.url);
		}
	});
});

describe("relayFetch", () => {
	it("sends relayed endpoints through the relay with the same request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
		const init = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"grant_type":"refresh_token"}',
		};
		await relayFetch("https://pi.dev")("https://platform.claude.com/v1/oauth/token", init);

		const [target, sent] = fetchSpy.mock.calls[0] ?? [];
		expect(String(target)).toBe(
			"https://pi.dev/api/oauth/relay?url=https%3A%2F%2Fplatform.claude.com%2Fv1%2Foauth%2Ftoken",
		);
		expect(sent).toBe(init);
	});

	it("sends every other request directly", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
		await relayFetch("https://pi.dev")("https://radius.pi.dev/v1/oauth/token", { method: "POST" });
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://radius.pi.dev/v1/oauth/token");
	});
});
