import { afterEach, describe, expect, it, vi } from "vitest";
import { antigravityOAuth } from "../src/auth/oauth/antigravity.ts";
import type { OAuthCredential } from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe.sequential("Antigravity OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("formats toAuth with bearer token and project header", async () => {
		const credential: OAuthCredential = {
			type: "oauth",
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600 * 1000,
			projectId: "custom-project-123",
		};

		const auth = await antigravityOAuth.toAuth(credential);
		expect(auth.apiKey).toBe("test-access-token");
		expect(auth.headers?.Authorization).toBe("Bearer test-access-token");
		expect(auth.headers?.["X-Antigravity-Project"]).toBe("custom-project-123");
	});

	it("refreshes expired token via Google OAuth endpoint", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://oauth2.googleapis.com/token");
			expect(init?.method).toBe("POST");
			const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("old-refresh-token");

			return jsonResponse({
				access_token: "new-access-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const oldCred: OAuthCredential = {
			type: "oauth",
			access: "old-access-token",
			refresh: "old-refresh-token",
			expires: Date.now() - 1000,
			projectId: "aicode-consumers",
		};

		const refreshed = await antigravityOAuth.refresh(oldCred, neverAbortedSignal);
		expect(refreshed.access).toBe("new-access-token");
		expect(refreshed.refresh).toBe("old-refresh-token");
		expect(refreshed.projectId).toBe("aicode-consumers");
	});
});
