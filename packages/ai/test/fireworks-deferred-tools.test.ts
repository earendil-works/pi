import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Tool, ToolResultMessage } from "../src/types.ts";

const lookup: Tool = {
	name: "lookup",
	description: "Look up a synthetic key",
	parameters: Type.Object({ key: Type.String() }),
};

function discoveryContext(model: Model<"anthropic-messages">, name = "tool_search"): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{ type: "thinking", thinking: "Find a lookup tool.", thinkingSignature: "" },
			{ type: "toolCall", id: "search1", name, arguments: { query: "lookup" } },
		],
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
	return {
		tools: [{ name, description: "Find tools", parameters: Type.Object({ query: Type.String() }) }, lookup],
		messages: [
			{ role: "user", content: "Look up alpha.", timestamp: 0 },
			assistant,
			{
				role: "toolResult",
				toolName: name,
				toolCallId: "search1",
				content: [{ type: "text", text: "Found lookup." }],
				addedToolNames: ["lookup"],
				isError: false,
				timestamp: 0,
			},
		],
	};
}

async function capture(model: Model<"anthropic-messages">, context: Context): Promise<MessageCreateParamsStreaming> {
	let payload: MessageCreateParamsStreaming | undefined;
	await streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey: "test-key",
		cacheRetention: "none",
		onPayload(value) {
			payload = value as MessageCreateParamsStreaming;
			throw new Error("payload captured");
		},
	}).result();
	if (!payload) throw new Error("Expected payload");
	return payload;
}

// Follow-up to #9323: Fireworks thinking support alone did not enable tool references.
describe("Fireworks deferred tools", () => {
	it.each([
		"accounts/fireworks/models/deepseek-v4-flash-0731",
		"accounts/fireworks/models/qwen3p8-max",
		"accounts/fireworks/models/kimi-k2p6",
	] as const)("serializes discovery and replay for %s", async (id) => {
		const model = getModel("fireworks", id);
		for (const name of ["ToolSearch", "tool_search", "discover_tools"]) {
			const context = discoveryContext(model, name);
			const payload = await capture(model, context);
			expect(payload.tools).toEqual([
				{
					name,
					description: "Find tools",
					input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
				},
				{
					name: "lookup",
					description: lookup.description,
					input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
					defer_loading: true,
				},
			]);
			expect(payload.messages[1].content).toContainEqual({
				type: "thinking",
				thinking: "Find a lookup tool.",
				signature: "",
			});
			expect(payload.messages[2].content).toEqual([
				{
					type: "tool_result",
					tool_use_id: "search1",
					content: [{ type: "tool_reference", tool_name: "lookup" }],
					is_error: false,
				},
				{ type: "text", text: "Found lookup." },
			]);

			// Fireworks unwraps tool_use_tool on the wire, even when the ID retains that prefix.
			const events = [
				{
					type: "message_start",
					message: { id: "msg_lookup", model: id, usage: { input_tokens: 100, output_tokens: 0 } },
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "tool_use_tool_1", name: "lookup", input: {} },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"key":"alpha"}' },
				},
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
				{ type: "message_stop" },
			];
			const response = await streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
				apiKey: "test-key",
				fetch: async () =>
					new Response(
						events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{ headers: { "content-type": "text/event-stream" } },
					),
			}).result();
			expect(response.stopReason).toBe("toolUse");
			expect(response.content).toEqual([
				{ type: "toolCall", id: "tool_use_tool_1", name: "lookup", arguments: { key: "alpha" } },
			]);
			context.messages.push(response, {
				role: "toolResult",
				toolCallId: "tool_use_tool_1",
				toolName: "lookup",
				content: [{ type: "text", text: "SYNTHETIC_ALPHA_17" }],
				isError: false,
				timestamp: 0,
			});
			const replay = await capture(model, context);
			expect(replay.tools).toEqual(payload.tools);
			expect(replay.messages[2]).toEqual(payload.messages[2]);
			expect(replay.messages[3].content).toEqual([
				{ type: "tool_use", id: "tool_use_tool_1", name: "lookup", input: { key: "alpha" } },
			]);
			expect(replay.messages[4].content).toEqual([
				{ type: "tool_result", tool_use_id: "tool_use_tool_1", content: "SYNTHETIC_ALPHA_17", is_error: false },
			]);
			context.messages.push({ role: "user", content: "Now look up beta.", timestamp: 0 });
			const next = await capture(model, context);
			expect(next.tools).toEqual(payload.tools);
			expect(next.messages.slice(0, -1)).toEqual(replay.messages);
		}
	});

	it("deduplicates references across multiple results and preserves ordinary text", async () => {
		const model = getModel("fireworks", "accounts/fireworks/models/kimi-k2p6");
		const context = discoveryContext(model);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content.push({ type: "toolCall", id: "search2", name: "tool_search", arguments: { query: "lookup" } });
		const result = context.messages[2] as ToolResultMessage;
		result.addedToolNames = ["lookup", "lookup", "missing"];
		context.messages.push({ ...result, toolCallId: "search2", content: [{ type: "text", text: "Already loaded." }] });
		const payload = await capture(model, context);
		expect(payload.messages[2].content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "search1",
				content: [{ type: "tool_reference", tool_name: "lookup" }],
				is_error: false,
			},
			{ type: "tool_result", tool_use_id: "search2", content: "Already loaded.", is_error: false },
			{ type: "text", text: "Found lookup." },
		]);
	});

	it.each(["no-discovery", "no-markers", "no-immediate", "already-used", "disabled"])(
		"keeps normal schemas for %s",
		async (scenario) => {
			const base = getModel("fireworks", "accounts/fireworks/models/kimi-k2p6");
			const model = { ...base, compat: { ...base.compat, supportsToolReferences: scenario !== "disabled" } };
			const context = discoveryContext(model);
			if (scenario === "no-discovery") context.messages = context.messages.slice(0, 1);
			if (scenario === "no-markers") delete (context.messages[2] as ToolResultMessage).addedToolNames;
			if (scenario === "no-immediate") context.tools = [lookup];
			if (scenario === "already-used") {
				const assistant = structuredClone(context.messages[1]) as AssistantMessage;
				assistant.content = [{ type: "toolCall", id: "earlier", name: "lookup", arguments: { key: "before" } }];
				context.messages.splice(1, 0, assistant, {
					role: "toolResult",
					toolCallId: "earlier",
					toolName: "lookup",
					content: [{ type: "text", text: "BEFORE" }],
					isError: false,
					timestamp: 0,
				});
			}
			const payload = await capture(model, context);
			expect(payload.tools?.some((tool) => "defer_loading" in tool)).toBe(false);
			expect(JSON.stringify(payload.messages)).not.toContain("tool_reference");
			expect(payload.tools).toContainEqual(expect.objectContaining({ name: "lookup" }));
		},
	);
});
