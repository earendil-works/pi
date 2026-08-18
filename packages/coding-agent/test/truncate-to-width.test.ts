import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

/**
 * Tests for truncateToWidth behavior with Unicode characters.
 *
 * These tests verify that truncateToWidth properly handles text with
 * Unicode characters that have different byte vs display widths.
 */
describe("truncateToWidth", () => {
	it("should truncate messages with Unicode characters correctly", () => {
		// This message contains a checkmark (✔) which may have display width > 1 byte
		const message = '✔ script to run › dev $ concurrently "vite" "node --import tsx ./';
		const width = 67;
		const maxMsgWidth = width - 2; // Account for cursor

		const truncated = truncateToWidth(message, maxMsgWidth);
		const truncatedWidth = visibleWidth(truncated);

		expect(truncatedWidth).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should handle emoji characters", () => {
		const message = "🎉 Celebration! 🚀 Launch 📦 Package ready for deployment now";
		const width = 40;
		const maxMsgWidth = width - 2;

		const truncated = truncateToWidth(message, maxMsgWidth);
		const truncatedWidth = visibleWidth(truncated);

		expect(truncatedWidth).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should handle mixed ASCII and wide characters", () => {
		const message = "Hello 世界 Test 你好 More text here that is long";
		const width = 30;
		const maxMsgWidth = width - 2;

		const truncated = truncateToWidth(message, maxMsgWidth);
		const truncatedWidth = visibleWidth(truncated);

		expect(truncatedWidth).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should not truncate messages that fit", () => {
		const message = "Short message";
		const width = 50;
		const maxMsgWidth = width - 2;

		const truncated = truncateToWidth(message, maxMsgWidth);

		expect(truncated).toBe(message);
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should add ellipsis when truncating", () => {
		const message = "This is a very long message that needs to be truncated";
		const width = 30;
		const maxMsgWidth = width - 2;

		const truncated = truncateToWidth(message, maxMsgWidth);

		expect(truncated).toContain("...");
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should handle the exact crash case from issue report", () => {
		// Terminal width was 67, line had visible width 68
		// The problematic text contained "✔" and "›" characters
		const message = '✔ script to run › dev $ concurrently "vite" "node --import tsx ./server.ts"';
		const terminalWidth = 67;
		const cursorWidth = 2; // "› " or "  "
		const maxMsgWidth = terminalWidth - cursorWidth;

		const truncated = truncateToWidth(message, maxMsgWidth);
		const finalWidth = visibleWidth(truncated);

		// The final line (cursor + message) must not exceed terminal width
		expect(finalWidth + cursorWidth).toBeLessThanOrEqual(terminalWidth);
	});
});
