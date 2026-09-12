import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorOAuth } from "../src/auth/oauth/cursor.ts";
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

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

describe.sequential("Cursor OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("formats toAuth with bearer token and Cursor User-Agent", async () => {
		const credential: OAuthCredential = {
			type: "oauth",
			access: "cursor-jwt-token",
			refresh: "cursor-refresh-token",
			expires: Date.now() + 3600 * 1000,
		};

		const auth = await cursorOAuth.toAuth(credential);
		expect(auth.apiKey).toBe("cursor-jwt-token");
		expect(auth.headers?.Authorization).toBe("Bearer cursor-jwt-token");
		expect(auth.headers?.["User-Agent"]).toBe("Cursor/0.46.0");
	});

	it("refreshes expired token via Cursor token endpoint", async () => {
		const fakeJwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString("base64")}.sig`;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://api2.cursor.sh/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.refresh_token).toBe("cursor-refresh-token");

			return jsonResponse({
				access_token: fakeJwt,
				refresh_token: "new-cursor-refresh-token",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const oldCred: OAuthCredential = {
			type: "oauth",
			access: "old-access-token",
			refresh: "cursor-refresh-token",
			expires: Date.now() - 1000,
		};

		const refreshed = await cursorOAuth.refresh(oldCred, neverAbortedSignal);
		expect(refreshed.access).toBe(fakeJwt);
		expect(refreshed.refresh).toBe("new-cursor-refresh-token");
	});
});
