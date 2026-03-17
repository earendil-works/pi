/**
 * Tests for resolve-config-value cache TTL behavior.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConfigValueCache, resolveConfigValue } from "../src/core/resolve-config-value.js";

describe("resolveConfigValue", () => {
	afterEach(() => {
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	it("should resolve literal values directly", () => {
		expect(resolveConfigValue("my-api-key")).toBe("my-api-key");
	});

	it("should resolve environment variables", () => {
		process.env.TEST_PI_API_KEY = "env-value";
		expect(resolveConfigValue("TEST_PI_API_KEY")).toBe("env-value");
		delete process.env.TEST_PI_API_KEY;
	});

	it("should cache shell command results", () => {
		const result1 = resolveConfigValue("!echo test-value");
		const result2 = resolveConfigValue("!echo test-value");
		expect(result1).toBe("test-value");
		expect(result2).toBe("test-value");
	});

	it("should re-execute shell command after TTL expires", () => {
		vi.useFakeTimers();

		// First call — caches the result
		const result1 = resolveConfigValue("!echo ttl-test", 1);
		expect(result1).toBe("ttl-test");

		// Within TTL — returns cached
		vi.advanceTimersByTime(500);
		const result2 = resolveConfigValue("!echo ttl-test", 1);
		expect(result2).toBe("ttl-test");

		// After TTL — re-executes
		vi.advanceTimersByTime(600);
		const result3 = resolveConfigValue("!echo ttl-test", 1);
		expect(result3).toBe("ttl-test");

		vi.useRealTimers();
	});

	it("should cache forever when no TTL is specified", () => {
		vi.useFakeTimers();

		const result1 = resolveConfigValue("!echo forever-cached");
		expect(result1).toBe("forever-cached");

		// Even after a long time, cached value persists
		vi.advanceTimersByTime(3600 * 1000);
		const result2 = resolveConfigValue("!echo forever-cached");
		expect(result2).toBe("forever-cached");

		vi.useRealTimers();
	});

	it("should clear all cached values", () => {
		resolveConfigValue("!echo clear-test");
		clearConfigValueCache();
		// After clear, the command will be re-executed
		const result = resolveConfigValue("!echo clear-test");
		expect(result).toBe("clear-test");
	});
});
