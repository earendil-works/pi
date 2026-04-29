import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGlooTokenCache, loginGloo, refreshGlooToken } from "../src/utils/oauth/gloo.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getFormBody(init?: RequestInit): URLSearchParams {
	if (!(init?.body instanceof URLSearchParams)) {
		throw new Error(`Expected URLSearchParams request body, got ${typeof init?.body}`);
	}
	return init.body;
}

describe.sequential("Gloo OAuth", () => {
	afterEach(() => {
		clearGlooTokenCache();
		vi.unstubAllGlobals();
	});

	it("prompts for client credentials and optional label, validates them, and returns persisted credentials", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.ai.gloo.com/oauth2/token");
			expect(init?.method).toBe("POST");
			expect(init?.headers).toMatchObject({
				"Content-Type": "application/x-www-form-urlencoded",
			});
			expect(String((init?.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
			const body = getFormBody(init);
			expect(body.get("grant_type")).toBe("client_credentials");
			expect(body.get("scope")).toBe("api/access");
			return jsonResponse({
				access_token: "access-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const prompts = ["client-id", "client-secret", "servant-internal"];
		const authUrls: string[] = [];
		const progress: string[] = [];

		const credentials = await loginGloo({
			onAuth: (info) => authUrls.push(info.url),
			onPrompt: async () => prompts.shift() ?? "",
			onProgress: (message) => progress.push(message),
		});

		expect(authUrls).toEqual(["https://studio.ai.gloo.com/api-credentials"]);
		expect(progress.at(-1)).toBe("Gloo credentials validated.");
		expect(credentials).toMatchObject({
			clientId: "client-id",
			baseUrl: "https://platform.ai.gloo.com",
			label: "servant-internal",
			refresh: "client-secret",
			access: "access-token",
		});
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("refreshes persisted credentials without dropping the label", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.ai.gloo.com/oauth2/token");
			expect(init?.method).toBe("POST");
			const body = getFormBody(init);
			expect(body.get("grant_type")).toBe("client_credentials");
			expect(body.get("scope")).toBe("api/access");
			return jsonResponse({
				access_token: "new-access-token",
				expires_in: 1800,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshGlooToken({
			clientId: "client-id",
			baseUrl: "https://platform.ai.gloo.com",
			label: "servant-internal",
			refresh: "client-secret",
			access: "old-access-token",
			expires: Date.now() - 1,
		});

		expect(credentials).toMatchObject({
			clientId: "client-id",
			baseUrl: "https://platform.ai.gloo.com",
			label: "servant-internal",
			refresh: "client-secret",
			access: "new-access-token",
		});
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
