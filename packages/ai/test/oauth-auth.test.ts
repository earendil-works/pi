import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";
import { anthropicOAuth } from "../src/utils/oauth/anthropic.ts";
import { githubCopilotOAuth } from "../src/utils/oauth/github-copilot.ts";
import { openaiCodexOAuth } from "../src/utils/oauth/openai-codex.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe.sequential("OAuthAuth adapters", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("anthropic toAuth derives the api key from the access token", async () => {
		const auth = await anthropicOAuth.toAuth({ type: "oauth", access: "token", refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: "token" });
	});

	it("openai-codex toAuth derives the api key from the access token", async () => {
		const auth = await openaiCodexOAuth.toAuth({ type: "oauth", access: "token", refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: "token" });
	});

	it("github-copilot toAuth derives baseUrl from the token proxy endpoint", async () => {
		const access = "tid=abc;exp=123;proxy-ep=proxy.enterprise.example;rest";
		const auth = await githubCopilotOAuth.toAuth({ type: "oauth", access, refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: access, baseUrl: "https://api.enterprise.example" });
	});

	it("github-copilot toAuth falls back to the enterprise domain, then the individual endpoint", async () => {
		const enterprise = await githubCopilotOAuth.toAuth({
			type: "oauth",
			access: "no-proxy-ep",
			refresh: "r",
			expires: 0,
			enterpriseUrl: "https://company.ghe.com",
		});
		expect(enterprise.baseUrl).toBe("https://copilot-api.company.ghe.com");

		const individual = await githubCopilotOAuth.toAuth({
			type: "oauth",
			access: "no-proxy-ep",
			refresh: "r",
			expires: 0,
		});
		expect(individual.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	it("anthropic refresh exchanges the refresh token and returns a typed credential", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
			),
		);

		const refreshed = await anthropicOAuth.refresh({ type: "oauth", access: "old", refresh: "old-r", expires: 0 });
		expect(refreshed.type).toBe("oauth");
		expect(refreshed.access).toBe("new-access");
		expect(refreshed.refresh).toBe("new-refresh");
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});

	it("github-copilot refresh preserves the enterprise domain", async () => {
		const fetchedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: unknown) => {
			const url = typeof input === "string" ? input : String(input);
			fetchedUrls.push(url);
			if (url.endsWith("/models")) {
				return jsonResponse({ data: [] });
			}
			return jsonResponse({ token: "new-token", expires_at: 9999999999 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const refreshed = await githubCopilotOAuth.refresh({
			type: "oauth",
			access: "old",
			refresh: "gh-token",
			expires: 0,
			enterpriseUrl: "company.ghe.com",
		});
		expect(refreshed.access).toBe("new-token");
		expect(refreshed.enterpriseUrl).toBe("company.ghe.com");
		expect(fetchedUrls[0]).toContain("api.company.ghe.com");
	});
});

describe("OAuth through Models.getAuth (lazy load chain)", () => {
	it("resolves stored anthropic oauth credentials via the lazy flow import", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({
			type: "oauth",
			access: "oauth-access-token",
			refresh: "r",
			expires: Date.now() + 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(anthropicProvider());

		const model = models.getModels("anthropic")[0];
		const result = await models.getAuth(model);
		expect(result?.auth.apiKey).toBe("oauth-access-token");
		expect(result?.source).toBe("OAuth");
	});

	it("resolves stored github-copilot oauth credentials including per-credential baseUrl", async () => {
		const access = "tid=abc;exp=123;proxy-ep=proxy.business.githubcopilot.com;rest";
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("github-copilot", async () => ({
			type: "oauth",
			access,
			refresh: "r",
			expires: Date.now() + 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(githubCopilotProvider());

		const model = models.getModels("github-copilot")[0];
		const result = await models.getAuth(model);
		expect(result?.auth.apiKey).toBe(access);
		expect(result?.auth.baseUrl).toBe("https://api.business.githubcopilot.com");
	});
});
