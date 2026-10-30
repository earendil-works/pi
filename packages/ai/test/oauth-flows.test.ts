import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCreateServer } from "../src/auth/oauth/callback-server.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { getBuiltinOAuthFlow, registerOAuthFlows } from "../src/oauth-flows.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";

const tokenResponse = () =>
	new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }), {
		headers: { "content-type": "application/json" },
	});

const stale: OAuthCredential = { type: "oauth", access: "stale", refresh: "old", expires: 0 };

afterEach(() => {
	registerOAuthFlows();
	vi.unstubAllGlobals();
});

describe("registerOAuthFlows", () => {
	it("sends every flow request through the registered fetch", async () => {
		const relay = vi.fn(async () => tokenResponse());
		registerOAuthFlows({ fetch: relay });

		const refreshed = await anthropicProvider().auth.oauth?.refresh(stale, new AbortController().signal);
		expect(refreshed).toMatchObject({ access: "fresh", refresh: "rotated" });
		expect(relay).toHaveBeenCalledWith("https://platform.claude.com/v1/oauth/token", expect.anything());
	});

	it("restores the global fetch without one", async () => {
		registerOAuthFlows({ fetch: async () => new Response("relay is gone", { status: 500 }) });
		registerOAuthFlows();
		const global = vi.fn(async () => tokenResponse());
		vi.stubGlobal("fetch", global);

		await anthropicProvider().auth.oauth?.refresh(stale, new AbortController().signal);
		expect(global).toHaveBeenCalledOnce();
	});
});

describe("getBuiltinOAuthFlow", () => {
	it("finds the flow of each built-in OAuth provider", () => {
		for (const id of [
			"anthropic",
			"openai",
			"openai-codex",
			"github-copilot",
			"openrouter",
			"kimi-coding",
			"meta",
			"xai",
			"radius",
		]) {
			expect(getBuiltinOAuthFlow(id), id).toBeDefined();
		}
		expect(getBuiltinOAuthFlow("google")).toBeUndefined();
	});
});

describe("loadCreateServer", () => {
	it("loads node:http where Node runs", async () => {
		expect(typeof (await loadCreateServer())).toBe("function");
	});
});
