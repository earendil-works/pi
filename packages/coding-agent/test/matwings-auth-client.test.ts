import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApiError,
	fetchPublicKey,
	isAccountSelection,
	loginPassword,
	mapAuthError,
} from "../src/core/matwings-auth/client.ts";

interface MockResponse {
	status: number;
	body: unknown;
}

function mockFetch(response: MockResponse) {
	return vi.fn(async () => {
		const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
		const r: Response = {
			ok: response.status < 400,
			status: response.status,
			json: async () => response.body,
			text: async () => text,
		} as Response;
		return r;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("matwings-auth client", () => {
	it("fetchPublicKey GETs /api/auth/password-public-key", async () => {
		const f = mockFetch({ status: 200, body: { public_key_pem: "PEM" } });
		vi.stubGlobal("fetch", f);
		const res = await fetchPublicKey();
		expect(res.public_key_pem).toBe("PEM");
		expect(f).toHaveBeenCalledOnce();
		const [url, init] = f.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/auth/password-public-key");
		expect(init.method).toBe("GET");
	});

	it("loginPassword POSTs {identifier,password} to /api/user/login", async () => {
		const f = mockFetch({
			status: 200,
			body: {
				access_token: "a",
				refresh_token: "r",
				expires_at: "2030-01-01T00:00:00Z",
				token_type: "bearer",
				user: { id: 1, name: "x" },
			},
		});
		vi.stubGlobal("fetch", f);
		const res = await loginPassword("u@x.com", "enc:abc");
		expect(res.access_token).toBe("a");
		const [, init] = f.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ identifier: "u@x.com", password: "enc:abc" });
		expect((init.headers as Record<string, string>)["Accept-Language"]).toMatch(/zh|en/);
	});

	it("throws ApiError on non-ok with mapped message", async () => {
		vi.stubGlobal("fetch", mockFetch({ status: 401, body: { detail: "nope" } }));
		await expect(fetchPublicKey()).rejects.toMatchObject({ name: "ApiError", status: 401 });
		await expect(Promise.reject(new ApiError(401, undefined, "x"))).rejects.toBeInstanceOf(ApiError);
	});

	it("maps status/code/detail to friendly messages", () => {
		expect(mapAuthError(undefined, undefined, 401)).toContain("未授权");
		expect(mapAuthError("RATE_LIMITED", undefined, 429)).toContain("频繁");
		expect(mapAuthError("INVALID_CREDENTIALS", undefined, 400)).toContain("账号或密码错误");
		expect(mapAuthError("DUPLICATE_PHONE", undefined, 400)).toContain("手机号");
	});

	it("detects account-selection shape", () => {
		expect(
			isAccountSelection({
				requires_account_selection: true,
				selection_token: "s",
				accounts: [],
			} as never),
		).toBe(true);
		expect(isAccountSelection({ access_token: "a" } as never)).toBe(false);
	});
});
