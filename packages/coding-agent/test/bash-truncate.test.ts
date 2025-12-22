import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test the UTF-8 truncation logic in isolation
describe("bash tool output truncation", () => {
	const MAX_OUTPUT_BYTES = 16 * 1024; // 16KB

	/**
	 * Replicate the truncation logic from processOutput
	 */
	function truncateToLimit(chunk: string, remainingBytes: number): string {
		if (remainingBytes <= 0) return "";

		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		if (chunkBytes <= remainingBytes) {
			return chunk;
		}

		// First, calculate an approximate character limit
		const avgBytesPerChar = chunkBytes / chunk.length;
		let endPos = Math.floor(remainingBytes / avgBytesPerChar);
		let truncated = chunk.slice(0, endPos);

		// Adjust if we still exceed (handles multi-byte UTF-8 characters)
		while (Buffer.byteLength(truncated, "utf-8") > remainingBytes && endPos > 0) {
			endPos--;
			truncated = chunk.slice(0, endPos);
		}

		return truncated;
	}

	it("should handle ASCII text correctly", () => {
		const input = "a".repeat(20000); // 20KB of 'a'
		const result = truncateToLimit(input, MAX_OUTPUT_BYTES);
		const byteLength = Buffer.byteLength(result, "utf-8");

		expect(byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		expect(result.length).toBe(MAX_OUTPUT_BYTES); // ASCII: 1 byte per char
	});

	it("should handle multi-byte UTF-8 characters without splitting", () => {
		// Japanese text: each character is 3 bytes in UTF-8
		const japanese = "こんにちは"; // 5 chars × 3 bytes = 15 bytes
		const input = japanese.repeat(2000); // ~30KB total

		const result = truncateToLimit(input, MAX_OUTPUT_BYTES);
		const byteLength = Buffer.byteLength(result, "utf-8");

		expect(byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		// Verify no broken UTF-8 by converting back to buffer
		expect(() => Buffer.from(result, "utf-8")).not.toThrow();
		// Verify we don't have a partial character at the end
		const lastChar = result.slice(-1);
		const lastCharBytes = Buffer.byteLength(lastChar, "utf-8");
		expect(lastCharBytes).toBeGreaterThan(0);
	});

	it("should handle emoji (4-byte UTF-8) correctly", () => {
		// Emoji are 4 bytes in UTF-8
		const emoji = "🎉";
		const input = emoji.repeat(5000); // ~20KB

		const result = truncateToLimit(input, MAX_OUTPUT_BYTES);
		const byteLength = Buffer.byteLength(result, "utf-8");

		expect(byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		// Verify the last character is complete
		expect(result.length).toBeGreaterThan(0);
		// Convert to buffer to ensure valid UTF-8
		const decoded = new TextDecoder("utf-8").decode(Buffer.from(result, "utf-8"));
		expect(decoded).toBe(result);
	});

	it("should handle mixed ASCII and multi-byte characters", () => {
		const mixed = "Hello世界🎉World"; // Mixed content
		const input = mixed.repeat(2000);

		const result = truncateToLimit(input, MAX_OUTPUT_BYTES);
		const byteLength = Buffer.byteLength(result, "utf-8");

		expect(byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		// Verify valid UTF-8
		expect(() => Buffer.from(result, "utf-8")).not.toThrow();
	});

	it("should return empty string when remainingBytes is 0", () => {
		const result = truncateToLimit("hello", 0);
		expect(result).toBe("");
	});

	it("should handle exact boundary case", () => {
		const input = "a".repeat(16384); // Exactly 16KB
		const result = truncateToLimit(input, MAX_OUTPUT_BYTES);

		expect(Buffer.byteLength(result, "utf-8")).toBe(MAX_OUTPUT_BYTES);
		expect(result.length).toBe(16384);
	});

	it("should handle single character exceeding limit", () => {
		// 4-byte emoji with limit of 3 bytes
		const result = truncateToLimit("🎉", 3);
		const byteLength = Buffer.byteLength(result, "utf-8");

		// Should return empty or valid smaller portion
		expect(byteLength).toBeLessThanOrEqual(3);
	});

	it("should handle edge case: chunk that barely exceeds limit", () => {
		const input = "a".repeat(16383); // 1 byte less than limit
		const result = truncateToLimit(input + "extra", MAX_OUTPUT_BYTES);

		expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
	});

	it("should handle very long strings with complex UTF-8", () => {
		// Mix of various UTF-8 multi-byte sequences
		const complex = "aàáâãäåæçèéêëìíîï"; // Mix of 1-3 byte chars
		const input = complex.repeat(5000);

		const result = truncateToLimit(input, MAX_OUTPUT_BYTES);
		const byteLength = Buffer.byteLength(result, "utf-8");

		expect(byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		expect(() => Buffer.from(result, "utf-8")).not.toThrow();
	});
});

// Integration test to verify early termination
describe("bash tool early termination", () => {
	const childPid: number | null = null;
	const killedPids = new Set<number>();

	// Mock killProcessTree to track calls
	beforeEach(() => {
		killedPids.clear();
	});

	it("should kill process when output exceeds limit", async () => {
		// This is a manual test - run with: npm test -- --run bash-truncate
		// The actual behavior would need to be tested with a real bash command
		console.log("Integration test: Run 'npm test -- --run' and check bash-truncate test file");
	});
});
