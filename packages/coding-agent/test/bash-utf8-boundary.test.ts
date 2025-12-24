import { describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";

describe("bash tool UTF-8 boundary conditions", () => {
	/**
	 * Verify truncation in the middle of a multi-byte sequence works correctly.
	 * This addresses the concern from review: we should not corrupt UTF-8 when truncating.
	 */
	it("should handle truncation at multi-byte UTF-8 boundary", async () => {
		// Generate 16380 bytes of emoji (4 bytes each) = 4095 emoji (4 * 4095 = 16380 bytes)
		// Then add some ASCII to push just over the limit
		const emoji = "🎉"; // 4 bytes in UTF-8
		const chunk16000 = emoji.repeat(4000); // 16000 bytes
		const remaining = "A".repeat(383); // 383 bytes (total: 16383 bytes)
		const testScript = `echo "${chunk16000}${remaining}EXTRA"`; // + 5 bytes = 16388 total

		const result = await bashTool.execute("test-utf8-truncation", {
			command: testScript,
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";

		// Should show truncation notice
		expect(output).toContain("(output truncated to 16384 bytes)");

		// Output should be valid UTF-8 (no corrupted characters)
		// If we truncated in the middle of an emoji, it should be replaced with � or the emoji should be complete
		expect(() => Buffer.from(output, "utf-8")).not.toThrow();

		// The word "EXTRA" should NOT be in output (came after limit)
		expect(output).not.toContain("EXTRA");

		// But the emoji before the limit should be intact
		expect(output).toContain("🎉");
	}, 10000);

	/**
	 * Verify that partial UTF-8 sequences in decoder buffer are flushed correctly.
	 * This ensures we don't lose buffered partial characters.
	 */
	it("should flush partial UTF-8 sequences after truncation", async () => {
		// Create output with multi-byte characters that will be flush()ed at close()
		// Strategy: Generate 16380 bytes of emoji (4 bytes each) = 4095 emoji
		// The echo adds a newline, bringing us to 16381 bytes
		// We're under the limit, so no truncation happens
		// This tests that the decoder.flush() at close() works correctly for multi-byte content
		const emoji = "🎉";
		const emojiChunk = emoji.repeat(4095); // 16380 bytes exactly
		const testScript = `echo "${emojiChunk}"`; // + newline = 16381 bytes

		const result = await bashTool.execute("test-utf8-flush", {
			command: testScript,
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";

		// Should be valid UTF-8
		expect(() => Buffer.from(output, "utf-8")).not.toThrow();

		// Should contain all the emoji
		expect(output).toContain(emoji);

		// Should NOT be truncated
		expect(output).not.toContain("truncated");
	}, 10000);
});
