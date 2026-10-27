import { describe, expect, it } from "vitest";
import { type OpenAIResponsesOptions, stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface Payload {
	input: Array<Record<string, unknown>>;
	reasoning?: { effort?: string };
}

const thinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

function openAIModel(compat: Model<"openai-responses">["compat"] = { supportsMidConvoEffort: true }) {
	return {
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		compat,
	} satisfies Model<"openai-responses">;
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

const toolResult = (callId: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "lookup",
	content: [{ type: "text", text: "result" }],
	isError: false,
	timestamp: 0,
});

const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });

function responseEvents(responseId: string, withToolCall: boolean): object[] {
	const item = withToolCall
		? { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" }
		: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "answer", annotations: [] }],
			};
	return [
		{ type: "response.created", response: { id: responseId } },
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: responseId, status: "completed" } },
	];
}

async function runOpenAI(
	messages: Message[],
	reasoningEffort: OpenAIResponsesOptions["reasoningEffort"],
	options: { apiKey?: string; model?: Model<"openai-responses">; withToolCall?: boolean } = {},
): Promise<{ payload: Payload; message: AssistantMessage }> {
	let payload: Payload | undefined;
	const fetchMock = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		payload = JSON.parse(String(init?.body)) as Payload;
		const body = responseEvents("resp_1", options.withToolCall ?? false)
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const message = await streamOpenAIResponses(options.model ?? openAIModel(), normalizeContext({ messages }), {
		apiKey: options.apiKey ?? "sk-test",
		reasoningEffort,
		fetch: fetchMock as typeof globalThis.fetch,
	}).result();
	if (!payload) throw new Error("Request payload was not captured");
	expect(message.stopReason).not.toBe("error");
	return { payload, message };
}

describe("OpenAI Responses configuration_update", () => {
	it("keeps reasoning.effort constant and only appends input when the level changes", async () => {
		const history: Message[] = [user("one")];
		const first = await runOpenAI(history, "high");
		history.push(first.message, user("two"));
		const second = await runOpenAI(history, "high");
		history.push(second.message, user("three"));
		const third = await runOpenAI(history, "low");

		expect(first.payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "one" }] },
			update("high"),
		]);
		for (const { payload } of [first, second, third]) {
			expect(payload.reasoning?.effort).toBe("medium");
		}
		expect(second.payload.input.slice(0, first.payload.input.length)).toEqual(first.payload.input);
		expect(third.payload.input.slice(0, second.payload.input.length)).toEqual(second.payload.input);
		expect(third.payload.input.filter((item) => item.type === "configuration_update")).toEqual([
			update("high"),
			update("high"),
			update("low"),
		]);
		expect(third.payload.input.at(-1)).toEqual(update("low"));
		expect([first, second, third].map(({ message }) => message.providerThinkingLevel)).toEqual([
			"high",
			"high",
			"low",
		]);
	});

	it("applies a level change made during a tool loop to the next reply", async () => {
		const history: Message[] = [user("one")];
		const toolCall = await runOpenAI(history, "high", { withToolCall: true });
		history.push(toolCall.message, toolResult("call_1|fc_1"));
		const afterTool = await runOpenAI(history, "low");

		expect(afterTool.payload.input.slice(0, toolCall.payload.input.length)).toEqual(toolCall.payload.input);
		expect(afterTool.payload.input.slice(-2)).toEqual([
			expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
			update("low"),
		]);
		expect(afterTool.message.providerThinkingLevel).toBe("low");
	});

	it("adds items only before replies recorded by this model", async () => {
		const unstamped = (await runOpenAI([user("one")], "high", { model: openAIModel({}) })).message;
		const otherProvider: AssistantMessage = { ...unstamped, provider: "opencode", providerThinkingLevel: "high" };
		const otherModel: AssistantMessage = { ...unstamped, model: "gpt-6-sol", providerThinkingLevel: "high" };
		const recorded: AssistantMessage = { ...unstamped, providerThinkingLevel: "high" };

		const { payload } = await runOpenAI(
			[
				user("one"),
				unstamped,
				user("two"),
				otherProvider,
				user("three"),
				otherModel,
				user("four"),
				recorded,
				user("five"),
			],
			"low",
		);

		expect(payload.input.map((item) => item.type ?? item.role)).toEqual([
			"user",
			"message",
			"user",
			"message",
			"user",
			"message",
			"user",
			"configuration_update",
			"message",
			"user",
			"configuration_update",
		]);
		expect(payload.input.filter((item) => item.type === "configuration_update")).toEqual([
			update("high"),
			update("low"),
		]);
	});

	it.each([
		{
			name: "Sign in with ChatGPT",
			apiKey: "chatgpt-access-token",
			model: openAIModel(),
			level: "low",
			effort: "low",
		},
		{
			name: "the compat flag turned off",
			apiKey: "sk-test",
			model: openAIModel({ supportsMidConvoEffort: false }),
			level: "low",
			effort: "low",
		},
		{ name: "thinking off", apiKey: "sk-test", model: openAIModel(), level: undefined, effort: "none" },
	] as const)("sends the level as reasoning.effort with $name", async ({ apiKey, model, level, effort }) => {
		const first = await runOpenAI([user("one")], "high", { apiKey, model });
		const { payload, message } = await runOpenAI([user("one"), first.message, user("two")], level, {
			apiKey,
			model,
		});

		expect(payload.reasoning?.effort).toBe(effort);
		expect(payload.input.some((item) => item.type === "configuration_update")).toBe(false);
		expect(message.providerThinkingLevel).toBeUndefined();
	});
});
