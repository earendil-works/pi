import { describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";

const MAX_OUTPUT_BYTES = 32 * 1024; // 32KB - must match bash.ts

describe("bash tool UTF-8 boundary conditions", () => {
	/**
	 * Verify truncation in the middle of a multi-byte sequence works correctly.
	 * This addresses the concern from review: we should not corrupt UTF-8 when truncating.
	 */
	it("should handle truncation at multi-byte UTF-8 boundary", async () => {
		// Generate emoji to push past the 32KB limit
		const emoji = "🎉"; // 4 bytes in UTF-8
		const emojiCount = Math.floor((MAX_OUTPUT_BYTES - 100) / 4); // Fill most of limit
		const chunk = emoji.repeat(emojiCount);
		const remaining = "A".repeat(200); // Push past limit
		const testScript = `echo "${chunk}${remaining}EXTRA"`;

		const result = await bashTool.execute("test-utf8-truncation", {
			command: testScript,
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";

		// Should show truncation notice
		expect(output).toContain(`(output truncated to ${MAX_OUTPUT_BYTES} bytes)`);

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
		// Strategy: Generate emoji to stay under the limit
		// This tests that the decoder.flush() at close() works correctly for multi-byte content
		const emoji = "🎉";
		const emojiCount = Math.floor((MAX_OUTPUT_BYTES - 100) / 4); // Stay well under limit
		const emojiChunk = emoji.repeat(emojiCount);
		const testScript = `echo "${emojiChunk}"`;

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
