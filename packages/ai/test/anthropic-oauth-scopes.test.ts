import { afterEach, describe, expect, it, vi } from "vitest";

const saveOAuthCredentialsMock = vi.fn();

vi.mock("../src/utils/oauth/storage.js", () => ({
	saveOAuthCredentials: saveOAuthCredentialsMock,
}));

describe("Anthropic OAuth scopes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		saveOAuthCredentialsMock.mockReset();
	});

	it("requests user:profile in the authorize URL and saves returned credentials", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "sk-ant-oat-test-access",
				refresh_token: "sk-ant-ort-test-refresh",
				expires_in: 3600,
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const { loginAnthropic } = await import("../src/utils/oauth/anthropic.js");

		let seenUrl = "";
		await loginAnthropic(
			(url) => {
				seenUrl = url;
			},
			async () => "auth-code#returned-state",
		);

		expect(seenUrl).toContain("https://claude.ai/oauth/authorize?");
		const params = new URL(seenUrl).searchParams;
		expect(params.get("scope")).toContain("user:profile");
		expect(params.get("scope")).toContain("user:inference");
		expect(params.get("scope")).toContain("org:create_api_key");

		expect(saveOAuthCredentialsMock).toHaveBeenCalledTimes(1);
		expect(saveOAuthCredentialsMock).toHaveBeenCalledWith(
			"anthropic",
			expect.objectContaining({
				access: "sk-ant-oat-test-access",
				refresh: "sk-ant-ort-test-refresh",
				type: "oauth",
			}),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
