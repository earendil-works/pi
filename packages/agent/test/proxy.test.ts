import type { AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("streamProxy", () => {
	// #9265: copying blocks for reactivity must not evaluate lazy arguments.
	it.each([true, false])("defers argument parsing and settles unread arguments (complete: %s)", async (complete) => {
		const content = "a".repeat(32 * 512);
		const deltas = ['{"content":"', ...Array<string>(32).fill("a".repeat(512))];
		if (complete) deltas.push('"}');
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test", toolName: "write" },
			...deltas.map((delta): ProxyAssistantMessageEvent => ({ type: "toolcall_delta", contentIndex: 0, delta })),
			...(complete
				? ([
						{
							type: "toolcall_end",
							contentIndex: 0,
							toolCall: { type: "toolCall", id: "call_test", name: "write", arguments: { content } },
						},
						{ type: "done", reason: "toolUse", usage },
					] satisfies ProxyAssistantMessageEvent[])
				: []),
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const parse = vi.spyOn(JSON, "parse");
		const result = await streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.example.com",
			},
		).result();
		expect(result.stopReason, result.errorMessage).toBe(complete ? "toolUse" : "error");
		if (complete) {
			expect(parse.mock.calls.filter(([text]) => text.startsWith('{"content":'))).toEqual([]);
		}
		expect(Object.getOwnPropertyDescriptor(result.content[0], "arguments")).toMatchObject({
			value: { content },
			writable: true,
		});
	});

	// #9265: lazy parsing must preserve the proxy's existing `parsed || {}` behavior.
	it.each(["null", "false", "0", '""'])("preserves the empty-object fallback for %s arguments", async (json) => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test", toolName: "write" },
			{ type: "toolcall_delta", contentIndex: 0, delta: json },
			{ type: "error", reason: "error", usage, errorMessage: "Interrupted" },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const result = await streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.example.com",
			},
		).result();
		expect(result.stopReason).toBe("error");
		const block = result.content[0];
		if (block.type !== "toolCall") throw new Error("Expected tool call");
		expect(block.arguments).toEqual({});
	});

	// #9265: preserve main's shallow-copy identity and extension metadata during live updates.
	it("copies live blocks without losing metadata or changing argument identity", async () => {
		let transport!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				transport = controller;
			},
		});
		const send = (...events: ProxyAssistantMessageEvent[]) => {
			transport.enqueue(
				new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
			);
		};
		send(
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test", toolName: "write" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"content":"hel' },
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.example.com" });
		const symbol = Symbol("metadata");
		const metadata = { source: "extension" };
		let first: ToolCall | undefined;
		let firstArguments: ToolCall["arguments"] | undefined;
		let last: ToolCall | undefined;
		for await (const event of stream) {
			if (event.type !== "toolcall_delta") continue;
			const block = event.partial.content[0];
			if (block.type !== "toolCall") throw new Error("Expected tool call");
			if (!first) {
				first = block;
				firstArguments = block.arguments;
				Object.assign(block, { extra: metadata, [symbol]: metadata });
				send({ type: "toolcall_delta", contentIndex: 0, delta: 'lo"}' });
			} else {
				last = block;
				expect(block).not.toBe(first);
				expect(block.arguments).toEqual({ content: "hello" });
				expect(block.arguments).toBe(first.arguments);
				expect(firstArguments).toEqual({ content: "hel" });
				expect(Reflect.get(block, "extra")).toBe(metadata);
				expect(Reflect.get(block, symbol)).toBe(metadata);
				send(
					{
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: {
							type: "toolCall",
							id: "call_test",
							name: "write",
							arguments: { content: "authoritative" },
						},
					},
					{ type: "done", reason: "toolUse", usage },
				);
				transport.close();
			}
		}
		const result = await stream.result();
		expect(result.content[0]).toBe(last);
		expect(Object.getOwnPropertyDescriptor(result.content[0], "arguments")).toMatchObject({
			value: { content: "authoritative" },
			writable: true,
		});
	});

	it("preserves tool-call metadata received only on toolcall_end", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(endEvent).toMatchObject({
			type: "toolcall_end",
			toolCall: { namespace: "dynamic_tools" },
		});
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});
	});

	// Regression tests for https://github.com/earendil-works/pi/issues/8996
	it("processes terminal metadata when the event is not newline-terminated", async () => {
		const start = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		const done = `data: ${JSON.stringify({ type: "done", reason: "stop", usage, providerThinkingLevel: "high" })}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(start + done, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.providerThinkingLevel).toBe("high");
	});

	it("emits an error instead of hanging when the stream ends without a terminal event", async () => {
		const body = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connection closed by proxy server");
	});
});
