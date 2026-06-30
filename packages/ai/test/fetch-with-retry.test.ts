import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../scripts/fetch-with-retry.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("fetchWithRetry", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns the response on first success without retrying", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);

		const response = await fetchWithRetry("https://example.test/api", { label: "test" });
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries on network failure and returns the eventual successful response", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("ECONNRESET"))
			.mockRejectedValueOnce(new Error("ECONNRESET"))
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);

		const response = await fetchWithRetry("https://example.test/api", {
			label: "test",
			timeoutMs: 1000,
			maxAttempts: 3,
		});
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("retries on non-OK HTTP response", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({}, 503))
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);

		const response = await fetchWithRetry("https://example.test/api", {
			label: "test",
			timeoutMs: 1000,
			maxAttempts: 3,
		});
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("throws after maxAttempts exhausted", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			throw new Error("ECONNRESET");
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchWithRetry("https://example.test/api", { label: "test", timeoutMs: 1000, maxAttempts: 2 }),
		).rejects.toThrow(/test failed after 2 attempts/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("passes the AbortSignal.timeout to the underlying fetch", async () => {
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect((init?.signal as AbortSignal).aborted).toBe(false);
			return jsonResponse({ ok: true });
		});
		vi.stubGlobal("fetch", fetchMock);

		await fetchWithRetry("https://example.test/api", { label: "test", timeoutMs: 5_000 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses exponential backoff between retries", async () => {
		const timestamps: number[] = [];
		const fetchMock = vi.fn(async (): Promise<Response> => {
			timestamps.push(Date.now());
			throw new Error("ECONNRESET");
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchWithRetry("https://example.test/api", {
				label: "test",
				timeoutMs: 1000,
				maxAttempts: 3,
			}),
		).rejects.toThrow();

		expect(timestamps.length).toBe(3);
		// 1st -> 2nd gap should be ~1000ms (2^0 * 1000)
		// 2nd -> 3rd gap should be ~2000ms (2^1 * 1000)
		const gap1 = timestamps[1]! - timestamps[0]!;
		const gap2 = timestamps[2]! - timestamps[1]!;
		expect(gap1).toBeGreaterThanOrEqual(900);
		expect(gap2).toBeGreaterThanOrEqual(1900);
	});
});
