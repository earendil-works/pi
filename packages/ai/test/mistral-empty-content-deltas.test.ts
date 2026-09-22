import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { FetchFunction } from "../src/types.ts";

const model = getModel("mistral", "devstral-medium-latest");
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

function event(delta: Record<string, unknown>, finishReason: string | null = null) {
	return {
		id: "mistral-response-id",
		model: model.id,
		choices: [
			{
				index: 0,
				finish_reason: finishReason,
				delta,
			},
		],
	};
}

function createFetch(events: object[]): FetchFunction {
	const body =
		events.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
	return async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function thinkingChunk(text: string) {
	return { type: "thinking", thinking: [{ text }] };
}

describe("Mistral empty content deltas (#9674)", () => {
	it("T-S1: tool_calls fragments with content:\"\" produce no empty text blocks", async () => {
		const events = [];
		for (let i = 0; i < 5; i++) {
			events.push(
				event({
					content: "",
					tool_calls: [
						{
							index: 0,
							id: i === 0 ? "call_abc" : null,
							type: "function",
							function: {
								name: i === 0 ? "lookup" : "",
								arguments: i === 0 ? '{"q":' : `"x${i}"`,
							},
						},
					],
				}),
			);
		}
		events.push(event({}, "tool_calls"));

		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch: createFetch(events),
		}).result();

		const emptyText = message.content.filter((b) => b.type === "text" && b.text === "");
		expect(emptyText).toEqual([]);
		const tools = message.content.filter((b) => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ type: "toolCall", name: "lookup" });
	});

	it("T-S2: leading/trailing empty string content do not create empty text", async () => {
		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch: createFetch([
				event({ content: "" }),
				event({ content: "hello" }),
				event({ content: "" }),
				event({}, "stop"),
			]),
		}).result();

		expect(message.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("T-S3: empty string between thinking deltas keeps a single thinking block", async () => {
		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch: createFetch([
				event({ content: [thinkingChunk("partA")] }),
				event({ content: "" }),
				event({ content: [thinkingChunk("partB")] }),
				event({}, "stop"),
			]),
		}).result();

		const thinking = message.content.filter((b) => b.type === "thinking");
		expect(thinking).toHaveLength(1);
		expect(thinking[0]).toEqual({ type: "thinking", thinking: "partApartB" });
		expect(message.content.filter((b) => b.type === "text")).toEqual([]);
	});

	it("T-S4: non-empty content with first tool_calls fragment keeps text and tool", async () => {
		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch: createFetch([
				event({
					content: "hello",
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "lookup", arguments: "{}" },
						},
					],
				}),
				event({}, "tool_calls"),
			]),
		}).result();

		expect(message.content.filter((b) => b.type === "text" && b.text === "")).toEqual([]);
		expect(message.content).toEqual([
			{ type: "text", text: "hello" },
			expect.objectContaining({ type: "toolCall", id: "call_1", name: "lookup" }),
		]);
	});

	it("structured empty text chunks are skipped without opening a text block", async () => {
		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch: createFetch([
				event({ content: [{ type: "text", text: "" }] }),
				event({ content: [{ type: "text", text: "ok" }] }),
				event({}, "stop"),
			]),
		}).result();

		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
	});
});
