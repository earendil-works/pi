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

	it("deduplicates concurrent refreshes into a single upstream request", async () => {
		getOAuthApiKeyMock.mockResolvedValue("sk-ant-oat-test");

		type FetchResponse = { ok: true; json: () => Promise<unknown> };
		let resolveFetch!: (value: FetchResponse) => void;
		const fetchMock = vi.fn(
			() =>
				new Promise<FetchResponse>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { fetchAnthropicOAuthUsageLimits, resetAnthropicOAuthUsageCache } = await import(
			"../src/utils/anthropic-oauth-usage.js"
		);
		resetAnthropicOAuthUsageCache();

		const firstPromise = fetchAnthropicOAuthUsageLimits({ force: true });
		const secondPromise = fetchAnthropicOAuthUsageLimits({ force: true });
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);

		resolveFetch({
			ok: true,
			json: async () => ({
				five_hour: { utilization: 25, resets_at: "2030-01-01T05:00:00.000Z" },
				seven_day: { utilization: 10, resets_at: "2030-01-07T00:00:00.000Z" },
			}),
		});

		const [first, second] = await Promise.all([firstPromise, secondPromise]);
		expect(first).toEqual(second);
	});
});
