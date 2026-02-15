import { describe, expect, it } from "vitest";

import { sanitizeToolCallId } from "../src/providers/openai-codex-responses.js";

describe("openai-codex sanitizeToolCallId", () => {
	it("derives a stable itemId when toolCall id has no item part", () => {
		const { callId, itemId } = sanitizeToolCallId("call_abc");
		expect(callId).toBe("call_abc");
		expect(itemId).toBe("fc_call_abc");
	});

	it("preserves explicit item id part", () => {
		const { callId, itemId } = sanitizeToolCallId("call_abc|fc_1");
		expect(callId).toBe("call_abc");
		expect(itemId).toBe("fc_1");
	});
});
