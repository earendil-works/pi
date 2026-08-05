import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("provider request retry callbacks", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports each retry before its backoff sleep", async () => {
		vi.useFakeTimers();
		const onRetry = vi.fn();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 2, onRetry });

		// Emitted before the sleep, so a caller can attribute the wait to a retry
		// rather than to a slow provider.
		await vi.advanceTimersByTimeAsync(0);
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onRetry).toHaveBeenCalledWith({
			attempt: 1,
			maxRetries: 2,
			delayMs: 1000,
			errorMessage: "Provider error: 429",
			status: 429,
		});

		await vi.advanceTimersByTimeAsync(1000);
		await expect(result).resolves.toBe("ok");
	});

	it("numbers attempts consecutively across several retries", async () => {
		vi.useFakeTimers();
		const attempts: number[] = [];
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(500))
			.mockRejectedValueOnce(providerError(500))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, {
			maxRetries: 3,
			onRetry: (info) => {
				attempts.push(info.attempt);
			},
		});

		await vi.advanceTimersByTimeAsync(60_000);
		await expect(result).resolves.toBe("ok");
		expect(attempts).toEqual([1, 2]);
	});

	it("is not called when the request succeeds first time", async () => {
		const onRetry = vi.fn();
		const request = vi.fn<() => Promise<string>>().mockResolvedValue("ok");

		await expect(retryProviderRequest(request, { maxRetries: 2, onRetry })).resolves.toBe("ok");
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("is not called for an error that is not retried", async () => {
		const onRetry = vi.fn();
		const error = providerError(400);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2, onRetry })).rejects.toBe(error);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("does not let a throwing observer break the retry", async () => {
		vi.useFakeTimers();
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(providerError(500)).mockResolvedValue("ok");

		const result = retryProviderRequest(request, {
			maxRetries: 1,
			onRetry: () => {
				throw new Error("observer blew up");
			},
		});

		await vi.advanceTimersByTimeAsync(60_000);
		// The recoverable provider error must still recover.
		await expect(result).resolves.toBe("ok");
	});
});
