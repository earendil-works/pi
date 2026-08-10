import type { ResponseOutputMessage } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("OpenAI Responses item_* ID namespace rejection", () => {
	it("rejects item_* content IDs and uses fallback for message-level IDs", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		// Simulate a persisted assistant message with textSignature containing an item_* ID
		// (as would happen when streaming a response.output_item.done with item.type === "message")
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "This text block has an item_* ID in its signature",
					textSignature: JSON.stringify({ v: 1, id: "item_a82c011efca1d9acdc8d92f7" }),
				},
			],
			api: "openai-codex",
			provider: "openai",
			model: "gpt-5.5",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "You are a test assistant.",
			messages: [{ role: "user", content: "test input", timestamp: Date.now() - 2000 }, assistant],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex"]));
		const messages = input.filter((item): item is ResponseOutputMessage => item.type === "message" && "id" in item);

		expect(messages).toHaveLength(1);
		const msgId = messages[0].id;

		// The item_* ID should have been rejected and replaced with the fallback msg_pi_* ID
		expect(msgId).not.toContain("item_");
		expect(msgId).toMatch(/^msg_pi_\d+$/);
		expect(msgId).toBe("msg_pi_1");
	});

	it("never emits item_* IDs in message-level input[].id fields", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const assistantWithItemId: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "First block",
					textSignature: JSON.stringify({ v: 1, id: "item_abc123" }),
				},
				{
					type: "text",
					text: "Second block",
					textSignature: JSON.stringify({ v: 1, id: "item_def456" }),
				},
			],
			api: "openai-codex",
			provider: "openai",
			model: "gpt-5.5",
			usage,
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() - 2000 }, assistantWithItemId],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex"]));
		const messageIds = input
			.filter(
				(item): item is ResponseOutputMessage =>
					item.type === "message" && "id" in item && typeof item.id === "string",
			)
			.map((item) => item.id);

		// Assert no item_* IDs appear in any message-level ID field
		for (const id of messageIds) {
			expect(id).not.toMatch(/^item_/);
		}
		// Verify fallback IDs were used
		expect(messageIds).toEqual(["msg_pi_1", "msg_pi_1_1"]);
	});

	it("uses fallback when cross-provider even with valid msg_* ID in textSignature", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		// Cross-provider messages use fallback IDs (different provider in this case)
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "This has a valid msg_* ID but from different provider",
					textSignature: JSON.stringify({ v: 1, id: "msg_valid_abc123" }),
				},
			],
			api: "anthropic-messages",
			provider: "anthropic", // Different provider
			model: "claude-opus-4-8",
			usage,
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "",
			messages: [{ role: "user", content: "test", timestamp: Date.now() - 2000 }, assistant],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex"]));
		const messages = input.filter((item): item is ResponseOutputMessage => item.type === "message" && "id" in item);

		expect(messages).toHaveLength(1);
		// Cross-provider uses fallback, not the original ID
		expect(messages[0].id).toBe("msg_pi_1");
	});
});
