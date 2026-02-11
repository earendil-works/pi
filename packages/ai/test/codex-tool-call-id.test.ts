import { describe, expect, it } from "vitest";
import { sanitizeToolCallId } from "../dist/providers/openai-codex-responses.js";

describe("sanitizeToolCallId", () => {
	it("should handle simple pipe-separated IDs", () => {
		const result = sanitizeToolCallId("call123|item456");
		expect(result.callId).toBe("call123");
		expect(result.itemId).toBe("fc_item456");
	});

	it("should add fc_ prefix if missing", () => {
		const result = sanitizeToolCallId("call123|abc");
		expect(result.itemId).toBe("fc_abc");
	});

	it("should keep fc_ prefix if already present", () => {
		const result = sanitizeToolCallId("call123|fc_xyz");
		expect(result.itemId).toBe("fc_xyz");
	});

	it("should replace special characters with underscores", () => {
		const result = sanitizeToolCallId("call@123|item#456");
		expect(result.callId).toBe("call_123");
		expect(result.itemId).toBe("fc_item_456");
	});

	it("should truncate to 64 characters", () => {
		const longId = "a".repeat(100) + "|" + "b".repeat(100);
		const result = sanitizeToolCallId(longId);
		expect(result.callId.length).toBeLessThanOrEqual(64);
		expect(result.itemId.length).toBeLessThanOrEqual(64);
		expect(result.itemId.startsWith("fc_")).toBe(true);
	});

	it("should strip trailing underscores", () => {
		const result = sanitizeToolCallId("call123_|item456__");
		expect(result.callId).toBe("call123");
		expect(result.itemId).toBe("fc_item456");
	});

	it("should handle IDs without pipe separator", () => {
		const result = sanitizeToolCallId("singleId");
		expect(result.callId).toBe("singleId");
		// When no itemId, we get minimum "fc_" prefix
		expect(result.itemId).toBe("fc_");
	});

	it("should handle empty itemId", () => {
		const result = sanitizeToolCallId("call123|");
		expect(result.callId).toBe("call123");
		expect(result.itemId).toBe("fc_");
	});
});
