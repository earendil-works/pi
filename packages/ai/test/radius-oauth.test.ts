import { afterEach, describe, expect, it, vi } from "vitest";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import type { AuthEvent, AuthInteraction } from "../src/auth/types.ts";

const GATEWAY = "https://radius.example";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported request input: ${String(input)}`);
}

function interaction(loginMethod: "browser" | "device-code", events: AuthEvent[] = []): AuthInteraction {
	return {
		prompt: async () => loginMethod,
		notify: (event) => events.push(event),
	};
}

describe("Radius OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("uses gateway endpoints directly for device login", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-24T00:00:00Z"));
		const events: AuthEvent[] = [];
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				const url = requestUrl(input);
				urls.push(url);
				const form = new URLSearchParams(String(init?.body));
				if (url === `${GATEWAY}/v1/oauth/device`) {
					expect(form.get("client_id")).toBe("pi-gateway");
					expect(form.get("scope")).toBe("gateway offline_access");
					return jsonResponse({
						device_code: "device-code",
						user_code: "ABCD-1234",
						verification_uri: "https://radius-ui.example/pair",
						expires_in: 600,
						interval: 5,
					});
				}
				if (url === `${GATEWAY}/v1/oauth/token`) {
					expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
					expect(form.get("client_id")).toBe("pi-gateway");
					expect(form.get("device_code")).toBe("device-code");
					return jsonResponse({
						access_token: "access-token",
						refresh_token: "refresh-token",
						expires_in: 3600,
						scope: "gateway offline_access",
					});
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		const oauth = createRadiusOAuth({ name: "Radius", gateway: GATEWAY });
		await expect(oauth.login(interaction("device-code", events))).resolves.toEqual({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600 * 1000 - 60_000,
			scope: "gateway offline_access",
		});
		expect(events).toEqual([
			{
				type: "device_code",
				userCode: "ABCD-1234",
				verificationUri: "https://radius-ui.example/pair",
				intervalSeconds: 5,
				expiresInSeconds: 600,
			},
		]);
		expect(urls).toEqual([`${GATEWAY}/v1/oauth/device`, `${GATEWAY}/v1/oauth/token`]);
	});

	it("refreshes directly through the gateway without discovery", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(requestUrl(input)).toBe(`${GATEWAY}/v1/oauth/token`);
			const form = new URLSearchParams(String(init?.body));
			expect(form.get("grant_type")).toBe("refresh_token");
			expect(form.get("client_id")).toBe("pi-gateway");
			expect(form.get("refresh_token")).toBe("old-refresh");
			return jsonResponse({
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const oauth = createRadiusOAuth({ name: "Radius", gateway: GATEWAY });
		await expect(
			oauth.refresh({ type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 }),
		).resolves.toMatchObject({ access: "new-access", refresh: "new-refresh" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("discovers only the interactive browser authorization endpoint", async () => {
		const fetchMock = vi.fn(async (input: unknown) => {
			expect(requestUrl(input)).toBe(`${GATEWAY}/v1/oauth`);
			return jsonResponse({ issuer: "https://radius-ui.example" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const oauth = createRadiusOAuth({ name: "Radius", gateway: GATEWAY });
		await expect(oauth.login(interaction("browser"))).rejects.toThrow(`Invalid Radius OAuth config from ${GATEWAY}`);
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
