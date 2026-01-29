import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, test } from "vitest";
import {
	buildSubscriptionResultText,
	createSubscriptionToolMessages,
	SUBSCRIPTION_TOOL_NAME,
} from "../src/subscriptions/subscription-messages.js";

function buildAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 456,
	};
}

describe("subscription message helpers", () => {
	test("buildSubscriptionResultText includes session id and assistant text", () => {
		const assistantMessage = buildAssistantMessage("All done.");
		const result = buildSubscriptionResultText({ sessionId: "session-123", assistantMessage });
		expect(result).toContain("session-123");
		expect(result).toContain("All done.");
	});

	test("createSubscriptionToolMessages builds tool call and result", () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Missing model for test");
		}
		const assistantMessage = buildAssistantMessage("Done message");
		const toolCallId = "tool-abc";

		const { assistantToolCallMessage, toolResultMessage } = createSubscriptionToolMessages({
			toolCallId,
			model,
			assistantMessage,
			sessionId: "session-xyz",
			now: 999,
		});

		expect(assistantToolCallMessage.role).toBe("assistant");
		expect(assistantToolCallMessage.stopReason).toBe("toolUse");

		const toolCall = assistantToolCallMessage.content.find((block) => block.type === "toolCall");
		expect(toolCall?.name).toBe(SUBSCRIPTION_TOOL_NAME);
		expect(toolCall?.id).toBe(toolCallId);
		expect(toolCall?.arguments).toEqual({
			sessionId: "session-xyz",
			stopReason: "stop",
			timestamp: 456,
		});

		expect(toolResultMessage.toolCallId).toBe(toolCallId);
		expect(toolResultMessage.toolName).toBe(SUBSCRIPTION_TOOL_NAME);
		expect(toolResultMessage.content[0]?.type).toBe("text");
	});
});
