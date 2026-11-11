import type {
	ResponseCreateParamsStreaming,
	ResponseOutputItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 1024,
};
const searchCall: ResponseOutputItem = {
	type: "tool_search_call",
	id: "tsc_test",
	call_id: null,
	execution: "server",
	status: "completed",
	arguments: { query: "lookup" },
};
const searchOutput: ResponseOutputItem = {
	type: "tool_search_output",
	id: "tso_test",
	call_id: null,
	execution: "server",
	status: "completed",
	tools: [
		{
			type: "namespace",
			name: "records",
			description: "Record tools",
			tools: [
				{ type: "function", name: "lookup", parameters: { type: "object", properties: {} }, defer_loading: true },
			],
		},
	],
};
const functionCall: ResponseOutputItem = {
	type: "function_call",
	id: "fc_test",
	call_id: "call_test",
	name: "lookup",
	arguments: "{}",
	namespace: "records",
};
const reasoning: ResponseOutputItem = { type: "reasoning", id: "rs_test", summary: [], encrypted_content: "opaque" };

async function parse(items: ResponseOutputItem[], terminalOnly = false): Promise<AssistantMessage> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
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
		stopReason: "pending",
		timestamp: 0,
	};
	async function* events(): AsyncIterable<ResponseStreamEvent> {
		for (const [output_index, item] of items.entries()) {
			if (terminalOnly && (item.type === "tool_search_call" || item.type === "tool_search_output")) continue;
			yield { type: "response.output_item.added", sequence_number: 0, output_index, item };
			yield { type: "response.output_item.done", sequence_number: 1, output_index, item };
		}
		yield {
			type: "response.completed",
			sequence_number: 2,
			response: { id: "resp_test", status: "completed", output: items },
		} as ResponseStreamEvent;
	}
	await processResponsesStream(events(), output, new AssistantMessageEventStream(), model);
	return output;
}

function replay(output: AssistantMessage, target = model) {
	return convertResponsesMessages(target, normalizeContext({ messages: [output] }), new Set(["openai"]));
}

describe("OpenAI hosted tool-search replay", () => {
	it.each([
		["vercel-ai-gateway", undefined, "tool_search"],
		["vercel-ai-gateway", "client", "tool_search"],
		["vercel-ai-gateway", "server", "pi_tool_search"],
		["openai", "server", "tool_search"],
	] as const)("handles legacy search on %s with %s search", async (provider, execution, name) => {
		const source = await parse([functionCall]);
		const call = source.content.find((block) => block.type === "toolCall");
		if (!call) throw new Error("Missing function call");
		call.name = "tool_search";
		let sent: ResponseCreateParamsStreaming | undefined;
		await streamResponses({ ...model, provider }, normalizeContext({ messages: [source] }), {
			apiKey: "test-key",
			maxRetries: 0,
			onPayload: (payload) => {
				const params = payload as ResponseCreateParamsStreaming;
				if (execution) params.tools = [{ type: "tool_search", execution }];
			},
			fetch: async (_url, init) => {
				sent = JSON.parse(String(init?.body)) as ResponseCreateParamsStreaming;
				return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', {
					headers: { "content-type": "text/event-stream" },
				});
			},
		}).result();
		expect(sent?.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function_call", name })]));
		expect(call.name).toBe("tool_search");
	});
	it("preserves the exact search pair between reasoning and a namespaced call after JSON persistence", async () => {
		const output = await parse([reasoning, searchCall, searchOutput, functionCall]);
		expect(output.toolSearchItems).toEqual([
			{ contentIndex: 1, item: JSON.stringify(searchCall) },
			{ contentIndex: 1, item: JSON.stringify(searchOutput) },
		]);
		expect(output.content.map((block) => block.type)).toEqual(["thinking", "toolCall"]);
		const input = replay(JSON.parse(JSON.stringify(output)) as AssistantMessage);
		expect(input.slice(0, 4)).toEqual([reasoning, searchCall, searchOutput, functionCall]);
		expect(input[4]).toMatchObject({ type: "function_call_output", call_id: "call_test" });
	});

	it("backfills terminal-only search items without duplicating streamed items", async () => {
		for (const terminalOnly of [false, true]) {
			const output = await parse([reasoning, searchCall, searchOutput, functionCall], terminalOnly);
			expect(replay(output).slice(0, 4)).toEqual([reasoning, searchCall, searchOutput, functionCall]);
			expect(output.toolSearchItems).toHaveLength(2);
		}
	});

	it("replays search-only replies and trailing search items", async () => {
		for (const items of [
			[searchCall, searchOutput],
			[reasoning, searchCall, searchOutput],
		]) {
			const output = await parse(items);
			expect(output.stopReason).toBe("stop");
			expect(replay(output)).toEqual(items);
		}
	});

	it("keeps anchors correct when an empty unsigned thinking block is dropped", async () => {
		const output = await parse([searchCall, searchOutput, functionCall]);
		output.content.unshift({ type: "thinking", thinking: "" });
		for (const entry of output.toolSearchItems ?? []) entry.contentIndex++;
		expect(replay(output).slice(0, 3)).toEqual([searchCall, searchOutput, functionCall]);
	});

	it("drops native search items and namespaces when switching model, provider, or API", async () => {
		const output = await parse([searchCall, searchOutput, functionCall]);
		for (const target of [
			{ ...model, id: "other" },
			{ ...model, provider: "proxy" },
			{ ...model, api: "openai-codex-responses" },
		]) {
			const input = convertResponsesMessages(target, normalizeContext({ messages: [output] }), new Set(["openai"]));
			expect(input.some((item) => item.type === "tool_search_call" || item.type === "tool_search_output")).toBe(
				false,
			);
			expect(input.find((item) => item.type === "function_call")).not.toHaveProperty("namespace");
		}
	});

	it.each(["error", "aborted"] as const)("does not replay incomplete %s turns", async (stopReason) => {
		const output = await parse([searchCall, searchOutput, functionCall]);
		output.stopReason = stopReason;
		expect(replay(output)).toEqual([]);
	});
});
