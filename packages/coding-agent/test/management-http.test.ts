import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/utils/management-http.ts";

afterEach(() => vi.restoreAllMocks());

describe("fetchWithRetry", () => {
	it("retries a transient transport failure once", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		const response = await fetchWithRetry("https://example.test");
		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("shares the timeout budget across attempts", async () => {
		const signals: AbortSignal[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			if (signals.length === 1) throw new Error("fetch failed");
			return Response.json({ ok: true });
		});

		const response = await fetchWithRetry("https://example.test", undefined, { timeoutMs: 1000 });
		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(signals[0]).toBe(signals[1]);
	});

	it("retries transient HTTP responses and returns the successful response", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		const response = await fetchWithRetry("https://example.test");
		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await expect(fetchWithRetry("https://example.test", { signal: controller.signal })).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
