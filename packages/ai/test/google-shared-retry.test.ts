import { afterEach, describe, expect, it, vi } from "vitest";
import { retryGoogleRequest } from "../src/api/google-shared.ts";

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

		const result = retryGoogleRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(500);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry when maxRetries is unset", async () => {
		const error = googleApiError(429);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryGoogleRequest(request)).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-retryable status", async () => {
		const error = googleApiError(400);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryGoogleRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
