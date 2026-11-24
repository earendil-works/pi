import { afterEach, describe, expect, it, vi } from "vitest";
import { retryGoogleRequest } from "../src/api/google-shared.ts";
import { getModel } from "../src/compat.ts";
import type { ProviderResponse } from "../src/types.ts";

const model = getModel("google", "gemini-2.5-flash");

/** Shaped like @google/genai's ApiError: has `status`, but no `headers`. */
function googleApiError(status: number): Error {
	return Object.assign(new Error(`got status: ${status}`), { status });
}

describe("google request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a headers-less SDK error with a retryable status", async () => {
		vi.useFakeTimers();
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(googleApiError(429)).mockResolvedValue("ok");

		const result = retryGoogleRequest(request, model, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(500);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry when maxRetries is unset", async () => {
		const error = googleApiError(429);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryGoogleRequest(request, model)).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-retryable status", async () => {
		const error = googleApiError(400);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryGoogleRequest(request, model, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	// #12376
	it("reports the failed status to onResponse with empty headers", async () => {
		const responses: ProviderResponse[] = [];
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(googleApiError(429));

		await expect(
			retryGoogleRequest(request, model, { onResponse: (response) => void responses.push(response) }),
		).rejects.toThrow("got status: 429");
		expect(responses).toEqual([{ status: 429, headers: {} }]);
	});
});
