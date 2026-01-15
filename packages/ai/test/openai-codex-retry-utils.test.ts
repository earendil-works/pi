import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexHttpError, getRetryDelay, isRetryableCodexError } from "../src/providers/openai-codex-responses.js";

describe("OpenAI Codex Retry Utilities", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns false when abort signal is set", () => {
		const controller = new AbortController();
		controller.abort();

		expect(isRetryableCodexError(new Error("network"), controller.signal)).toBe(false);
	});

	it("retries on 429 and 5xx responses", () => {
		expect(isRetryableCodexError(new CodexHttpError("rate limit", 429))).toBe(true);
		expect(isRetryableCodexError(new CodexHttpError("server", 503))).toBe(true);
	});

	it("does not retry on 4xx client errors", () => {
		expect(isRetryableCodexError(new CodexHttpError("bad request", 400))).toBe(false);
	});

	it("retries on network failures", () => {
		expect(isRetryableCodexError(new Error("fetch failed"))).toBe(true);
	});

	it("respects retry classes (transport disabled)", () => {
		expect(isRetryableCodexError(new Error("fetch failed"), undefined, ["429", "5xx"])).toBe(false);
	});

	it("uses retry-after delay when larger than backoff", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const error = new CodexHttpError("rate limit", 429, 5000);
		const delay = getRetryDelay(0, 1000, 10000, error);
		expect(delay).toBe(5000);
	});

	it("caps retry-after delay at maxDelay", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const error = new CodexHttpError("rate limit", 429, 20000);
		const delay = getRetryDelay(0, 1000, 8000, error);
		expect(delay).toBe(8000);
	});
});
