import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

function makeModel(): Model<"openai-responses"> {
	return {
		id: "gpt-6.1-sol",
		name: "GPT 6.1 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

function makeAssistantMessage(
	model: Model<"openai-responses">,
	toolCalls: { id: string; name: string }[],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content: toolCalls.map((tc) => ({
			type: "toolCall" as const,
			id: tc.id,
			name: tc.name,
			arguments: {},
		})),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function makeToolResult(toolCallId: string, toolName: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "output" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("transformMessages orphaned tool results", () => {
	it("drops a toolResult whose assistant call was truncated away", () => {
		const model = makeModel();
		// History starts mid-group: the call for call_old is gone, only its result remains.
		const messages: Message[] = [
			{ role: "user", content: "go on", timestamp: Date.now() },
			makeToolResult("call_old|fc_old", "bash"),
			makeAssistantMessage(model, [{ id: "call_new|fc_new", name: "read" }]),
			makeToolResult("call_new|fc_new", "read"),
		];

		const result = transformMessages(messages, model);
		const results = result.filter((m) => m.role === "toolResult");

		expect(results.map((m) => (m.role === "toolResult" ? m.toolCallId : ""))).toEqual(["call_new|fc_new"]);
	});

	it("drops toolResults trailing a skipped errored assistant turn", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "do it", timestamp: Date.now() },
			makeAssistantMessage(model, [{ id: "call_err|fc_err", name: "bash" }], "error"),
			makeToolResult("call_err|fc_err", "bash"),
			makeAssistantMessage(model, [{ id: "call_ok|fc_ok", name: "read" }]),
			makeToolResult("call_ok|fc_ok", "read"),
		];

		const result = transformMessages(messages, model);
		const results = result.filter((m) => m.role === "toolResult");

		expect(results.map((m) => (m.role === "toolResult" ? m.toolCallId : ""))).toEqual(["call_ok|fc_ok"]);
	});

	it("keeps intact call/result pairs and synthetic results for orphaned calls", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "run", timestamp: Date.now() },
			makeAssistantMessage(model, [{ id: "call_1|fc_1", name: "read" }]),
			makeToolResult("call_1|fc_1", "read"),
			makeAssistantMessage(model, [{ id: "call_2|fc_2", name: "bash" }]),
		];

		const result = transformMessages(messages, model);
		const results = result.filter((m) => m.role === "toolResult");

		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ toolCallId: "call_1|fc_1", isError: false });
		expect(results[1]).toMatchObject({ toolCallId: "call_2|fc_2", isError: true });
	});
});
