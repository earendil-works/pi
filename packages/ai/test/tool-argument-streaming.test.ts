import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { Api, Model } from "../src/types.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test",
		name: "Test",
		api,
		provider: "test",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const content = "a".repeat(32 * 512);
const deltas = ['{"content":"', ...Array<string>(32).fill("a".repeat(512)), '"}'];
const json = deltas.join("");
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface ProviderCase {
	name: string;
	events(deltas: string[], complete: boolean): object[];
	run(response: Response, signal?: AbortSignal): AssistantMessageEventStream;
}

const providers: ProviderCase[] = [
	{
		name: "openai-completions",
		events: (deltas, complete) => [
			...deltas.map((delta) => ({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: "call_test", function: { name: "write", arguments: delta } }] },
					},
				],
			})),
			...(complete ? [{ choices: [{ delta: {}, finish_reason: "tool_calls" }] }] : []),
		],
		run: (response, signal) =>
			streamCompletions(
				model("openai-completions"),
				{ messages: [] },
				{ apiKey: "test", fetch: async () => response, signal },
			),
	},
	{
		name: "mistral-conversations",
		events: (deltas, complete) => [
			...deltas.map((delta) => ({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: "call_test", function: { name: "write", arguments: delta } }] },
					},
				],
			})),
			...(complete ? [{ choices: [{ delta: {}, finish_reason: "tool_calls" }] }] : []),
		],
		run: (response, signal) =>
			streamMistral(
				model("mistral-conversations"),
				{ messages: [] },
				{ apiKey: "test", fetch: async () => response, signal },
			),
	},
	{
		name: "anthropic-messages",
		events: (deltas, complete) => [
			{
				type: "message_start",
				message: { id: "msg_test", model: "test", usage: { input_tokens: 0, output_tokens: 0 } },
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call_test", name: "write", input: {} },
			},
			...deltas.map((delta) => ({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: delta },
			})),
			...(complete
				? [
						{ type: "content_block_stop", index: 0 },
						{ type: "message_delta", delta: { stop_reason: "tool_use" } },
						{ type: "message_stop" },
					]
				: []),
		],
		run: (response, signal) =>
			streamAnthropic(
				model("anthropic-messages"),
				{ messages: [] },
				{ apiKey: "test", fetch: async () => response, signal },
			),
	},
	{
		name: "openai-responses",
		events: (deltas, complete) => [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "write", arguments: "" },
			},
			...deltas.map((delta) => ({ type: "response.function_call_arguments.delta", output_index: 0, delta })),
			...(complete
				? [
						{
							type: "response.output_item.done",
							output_index: 0,
							item: {
								type: "function_call",
								id: "fc_test",
								call_id: "call_test",
								name: "write",
								arguments: json,
							},
						},
						{ type: "response.completed", response: { id: "resp_test", status: "completed" } },
					]
				: []),
		],
		run: (response, signal) =>
			streamResponses(
				model("openai-responses"),
				{ messages: [] },
				{ apiKey: "test", fetch: async () => response, signal },
			),
	},
	{
		name: "pi-messages",
		events: (deltas, complete) => [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test", toolName: "write" },
			...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta })),
			...(complete
				? [
						{
							type: "toolcall_end",
							contentIndex: 0,
							toolCall: { type: "toolCall", id: "call_test", name: "write", arguments: { content } },
						},
						{ type: "done", reason: "toolUse", usage },
					]
				: [{ type: "error", reason: "error", errorMessage: "Interrupted", usage }]),
		],
		run: (response) =>
			streamPiMessages(model("pi-messages"), { messages: [] }, { apiKey: "test", fetch: async () => response }),
	},
];

function response(events: object[]): Response {
	return new Response(
		events
			.map((event) => {
				const eventName = "type" in event ? `event: ${event.type}\n` : "";
				return `${eventName}data: ${JSON.stringify(event)}\n\n`;
			})
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

afterEach(() => vi.restoreAllMocks());

// #9265: exercise real adapter loops, not just the lazy argument helper.
describe.each(providers)("$name tool argument parsing", (provider) => {
	it("does not parse intermediate prefixes for a delta-only consumer", async () => {
		const upstream = response(provider.events(deltas, true));
		const parse = vi.spyOn(JSON, "parse");
		const stream = provider.run(upstream);
		let deltaCount = 0;
		for await (const event of stream) {
			if (event.type === "toolcall_delta") deltaCount++;
		}
		const result = await stream.result();
		expect(result.stopReason, result.errorMessage).toBe("toolUse");
		expect(deltaCount).toBe(deltas.length);
		const argumentParses = parse.mock.calls.filter(([text]) => text.startsWith('{"content":'));
		expect(argumentParses.map(([text]) => text)).toEqual(provider.name === "pi-messages" ? [] : [json]);
		expect(Object.getOwnPropertyDescriptor(result.content[0], "arguments")?.get).toBeUndefined();
		expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: { content } });
	});

	it("preserves unread partial arguments when the stream fails", async () => {
		const result = await provider.run(response(provider.events(deltas.slice(0, -1), false))).result();
		expect(result.stopReason).toBe("error");
		expect(Object.getOwnPropertyDescriptor(result.content[0], "arguments")).toMatchObject({
			value: { content },
			writable: true,
		});
		expect(result.content[0]).not.toHaveProperty("partialJson");
		expect(result.content[0]).not.toHaveProperty("partialArgs");
	});
});

// #9265: unlike clean EOF, a transport error skips Completions/Mistral block-end parsing.
// pi-messages already returns a new, empty message for transport errors; leave that behavior unchanged.
describe.each(providers.filter((provider) => provider.name !== "pi-messages"))(
	"$name interrupted tool arguments",
	(provider) => {
		it.each(["error", "aborted"] as const)(
			"materializes unread arguments before toolcall_end (%s)",
			async (reason) => {
				const partialDeltas = ['{"content":"interrupted'];
				const bytes = new Uint8Array(await response(provider.events(partialDeltas, false)).arrayBuffer());
				let transport!: ReadableStreamDefaultController<Uint8Array>;
				const upstream = new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							transport = controller;
							controller.enqueue(bytes);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
				const controller = new AbortController();
				const stream = provider.run(upstream, controller.signal);
				let deltaCount = 0;
				for await (const event of stream) {
					expect(event.type).not.toBe("toolcall_end");
					if (event.type === "toolcall_delta" && ++deltaCount === partialDeltas.length) {
						if (reason === "aborted") controller.abort();
						transport.error(new Error("Connection interrupted"));
					}
				}
				const result = await stream.result();
				expect(deltaCount).toBe(partialDeltas.length);
				expect(result.stopReason).toBe(reason);
				if (reason === "error") expect(result.errorMessage).toContain("Connection interrupted");
				expect(Object.getOwnPropertyDescriptor(result.content[0], "arguments")).toMatchObject({
					value: { content: "interrupted" },
					writable: true,
				});
				expect(result.content[0]).not.toHaveProperty("partialJson");
				expect(result.content[0]).not.toHaveProperty("partialArgs");
			},
		);
	},
);
