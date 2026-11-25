import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, ToolResultMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("OpenAI Responses tool call replay", () => {
	// #12367: OpenAI returns tool calls with status "completed". Replaying them without it changes the input
	// before later reasoning items, which GPT-6.2 then drops as prefix_mismatch once a Codex WebSocket
	// continuation ends and the full input is sent again.
	it("replays function and custom tool calls with the status the API returned", () => {
		const model = getModel("openai-codex", "gpt-6.2-sol");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "calc.py" } },
				{ type: "toolCall", id: "call_2|ctc_2", name: "codemode", arguments: { code: "text(1)" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "Use the tools.", timestamp: Date.now() },
				assistant,
				toolResult("call_1|fc_1", "read"),
				toolResult("call_2|ctc_2", "codemode"),
			],
		});

		const input = convertResponsesMessages(model, context, new Set(["openai-codex"]), {
			grammarToolInputProperties: new Map([["codemode", "code"]]),
		});

		expect(input).toContainEqual({
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "read",
			arguments: '{"path":"calc.py"}',
			status: "completed",
		});
		expect(input).toContainEqual({
			type: "custom_tool_call",
			id: "ctc_2",
			call_id: "call_2",
			name: "codemode",
			input: "text(1)",
			status: "completed",
		});
	});
});
