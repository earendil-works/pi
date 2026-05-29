import { afterEach, describe, expect, it, vi } from "vitest";
import { extractRetryDelay } from "../src/providers/google-gemini-cli.ts";

describe("extractRetryDelay header parsing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("prefers Retry-After seconds header", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

		const response = new Response("", { headers: { "Retry-After": "5" } });
		const delay = extractRetryDelay("Please retry in 1s", response);

		expect(delay).toBe(6000);
	});

	it("parses Retry-After HTTP date header", () => {
		vi.useFakeTimers();
		const now = new Date("2025-01-01T00:00:00Z");
		vi.setSystemTime(now);

		const retryAt = new Date(now.getTime() + 12000).toUTCString();
		const response = new Response("", { headers: { "Retry-After": retryAt } });
		const delay = extractRetryDelay("", response);

		expect(delay).toBe(13000);
	});

	it("parses x-ratelimit-reset header", () => {
		vi.useFakeTimers();
		const now = new Date("2025-01-01T00:00:00Z");
		vi.setSystemTime(now);

		const resetAtMs = now.getTime() + 20000;
		const resetSeconds = Math.floor(resetAtMs / 1000).toString();
		const response = new Response("", { headers: { "x-ratelimit-reset": resetSeconds } });
		const delay = extractRetryDelay("", response);

		expect(delay).toBe(21000);
	});

	it("parses x-ratelimit-reset-after header", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

		const response = new Response("", { headers: { "x-ratelimit-reset-after": "30" } });
		const delay = extractRetryDelay("", response);

		expect(delay).toBe(31000);
	});
});
