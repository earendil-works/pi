import { afterEach, describe, expect, it, vi } from "vitest";

const getOAuthApiKeyMock = vi.fn();

vi.mock("../src/utils/oauth/index.js", () => ({
	getOAuthApiKey: getOAuthApiKeyMock,
}));

describe("Anthropic OAuth usage", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		getOAuthApiKeyMock.mockReset();
		const { resetAnthropicOAuthUsageCache } = await import("../src/utils/anthropic-oauth-usage.js");
		resetAnthropicOAuthUsageCache();
	});

	it("parses 5h and weekly usage windows into generic service usage limits", async () => {
		const { parseAnthropicOAuthUsageResponse } = await import("../src/utils/anthropic-oauth-usage.js");
		const limits = parseAnthropicOAuthUsageResponse({
			five_hour: {
				utilization: 42,
				resets_at: "2030-01-01T05:00:00.000Z",
			},
			seven_day: {
				utilization: 17,
				resets_at: "2030-01-07T00:00:00.000Z",
			},
		});

		expect(limits).toEqual({
			primary: {
				usedPercent: 42,
				windowMinutes: 300,
				resetsAt: 1893474000,
			},
			secondary: {
				usedPercent: 17,
				windowMinutes: 10080,
				resetsAt: 1893974400,
			},
		});
	});

	it("returns cached stale data when a subsequent refresh fails", async () => {
		getOAuthApiKeyMock.mockResolvedValue("sk-ant-oat-test");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					five_hour: { utilization: 25, resets_at: "2030-01-01T05:00:00.000Z" },
					seven_day: { utilization: 10, resets_at: "2030-01-07T00:00:00.000Z" },
				}),
			})
			.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
		vi.stubGlobal("fetch", fetchMock);

		const { fetchAnthropicOAuthUsageLimits, resetAnthropicOAuthUsageCache } = await import(
			"../src/utils/anthropic-oauth-usage.js"
		);
		resetAnthropicOAuthUsageCache();

		const first = await fetchAnthropicOAuthUsageLimits({ force: true });
		const second = await fetchAnthropicOAuthUsageLimits({ force: true });

		expect(first).toEqual(second);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
