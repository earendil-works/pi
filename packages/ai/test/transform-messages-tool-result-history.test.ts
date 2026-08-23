import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolCall } from "../src/types.ts";

function makeKimiModel(): Model<"openai-completions"> {
	return {
		id: "kimi-k3",
		name: "Kimi K3",
		api: "openai-completions",
		provider: "moonshotai-cn",
		baseUrl: "https://api.moonshot.cn/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
	};
}

function userMessage(content: string): Message {
	return { role: "user", content, timestamp: Date.now() };
}

function assistantToolCall(
	id: string,
	name: string,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	const toolCall: ToolCall = { type: "toolCall", id, name, arguments: {} };
	return {
		role: "assistant",
		content: [toolCall],
		api: "openai-completions",
		provider: "moonshotai-cn",
		model: "kimi-k3",
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

function toolResult(toolCallId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

const roles = (messages: Message[]): string => messages.map((m) => m.role).join(",");

describe("transformMessages: tool result history normalization", () => {
	const model = makeKimiModel();

	it("drops tool results belonging to skipped errored/aborted assistant messages", () => {
		const out = transformMessages(
			[userMessage("go"), assistantToolCall("c1", "bash", "error"), toolResult("c1", "output"), userMessage("next")],
			model,
		);
		expect(roles(out)).toBe("user,user");
	});

	it("drops the errored assistant but keeps healthy tool round-trips intact", () => {
		const out = transformMessages(
			[userMessage("go"), assistantToolCall("c2", "bash"), toolResult("c2", "output"), userMessage("next")],
			model,
		);
		expect(roles(out)).toBe("user,assistant,toolResult,user");
	});

	it("moves a tool result before an interleaved user message and removes the synthetic duplicate", () => {
		// Session order when a custom message (e.g. background-task notification)
		// lands between the assistant tool call and its result.
		const out = transformMessages(
			[
				userMessage("go"),
				assistantToolCall("c3", "subagent_wait"),
				userMessage("Background task notification"),
				toolResult("c3", "done"),
				userMessage("next"),
			],
			model,
		);
		// assistant, real tool result, then the interleaved user messages.
		// The synthetic "No result provided" duplicate must not be present.
		expect(roles(out)).toBe("user,assistant,toolResult,user,user");
		const resultIds = out
			.filter((m) => m.role === "toolResult")
			.map((m) => (m as Message & { toolCallId: string }).toolCallId);
		expect(resultIds).toEqual(["c3"]);
	});

	it("handles multiple tool calls with several interruptions", () => {
		const assistant = assistantToolCall("a", "bash");
		assistant.content = [
			{ type: "toolCall", id: "a", name: "bash", arguments: {} },
			{ type: "toolCall", id: "b", name: "bash", arguments: {} },
		];
		const out = transformMessages(
			[
				userMessage("go"),
				assistant,
				userMessage("note1"),
				toolResult("a", "A"),
				userMessage("note2"),
				toolResult("b", "B"),
				userMessage("next"),
			],
			model,
		);
		expect(roles(out)).toBe("user,assistant,toolResult,toolResult,user,user,user");
	});

	it("keeps the synthetic result when the real result never arrives", () => {
		const out = transformMessages([userMessage("go"), assistantToolCall("c5", "bash"), userMessage("next")], model);
		const resultIds = out
			.filter((m) => m.role === "toolResult")
			.map((m) => (m as Message & { toolCallId: string }).toolCallId);
		expect(resultIds).toEqual(["c5"]);
	});

	it("never emits duplicate tool_call_ids", () => {
		const out = transformMessages(
			[
				userMessage("go"),
				assistantToolCall("c6", "subagent_wait"),
				userMessage("notify"),
				toolResult("c6", "real"),
				userMessage("next"),
			],
			model,
		);
		const ids = out
			.filter((m) => m.role === "toolResult")
			.map((m) => (m as Message & { toolCallId: string }).toolCallId);
		expect(ids).toEqual(["c6"]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
