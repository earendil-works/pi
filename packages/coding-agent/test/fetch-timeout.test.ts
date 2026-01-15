import { describe, expect, it, vi } from "vitest";

// We'll test the fetchWithTimeout function once it's exported
describe("fetchWithTimeout", () => {
	it("should resolve when fetch completes before timeout", async () => {
		const { fetchWithTimeout } = await import("../src/tools-manager.js");

		// Mock fetch to resolve quickly
		const mockResponse = new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

		const result = await fetchWithTimeout("https://example.com", 5000);
		expect(result.status).toBe(200);

		fetchSpy.mockRestore();
	});

	it("should reject when timeout expires", async () => {
		const { fetchWithTimeout } = await import("../src/tools-manager.js");

		// Mock fetch to delay longer than timeout
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, options) => {
			// Wait for abort signal
			return new Promise((_, reject) => {
				const signal = options?.signal;
				if (signal) {
					signal.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				}
			});
		});

		// Use a very short timeout for the test
		await expect(fetchWithTimeout("https://example.com", 50)).rejects.toThrow();

		fetchSpy.mockRestore();
	}, 1000);

	it("should pass through request options", async () => {
		const { fetchWithTimeout } = await import("../src/tools-manager.js");

		const mockResponse = new Response("ok", { status: 200 });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

		await fetchWithTimeout("https://example.com", 5000, {
			headers: { "User-Agent": "test" },
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://example.com",
			expect.objectContaining({
				headers: { "User-Agent": "test" },
				signal: expect.any(AbortSignal),
			}),
		);

		fetchSpy.mockRestore();
	});
});
