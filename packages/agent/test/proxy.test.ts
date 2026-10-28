import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
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
});

describe("streamProxy", () => {
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

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
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

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
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

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connection closed by proxy server");
	});

	// #9265
	it("shows growing partial arguments without keeping the raw text on the block, in linear time", async () => {
		const content = 'line "quoted" \\ end\n'.repeat(20_000);
		const text = JSON.stringify({ path: "a.ts", content });
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "write" },
		];
		for (let index = 0; index < text.length; index += 32) {
			proxyEvents.push({ type: "toolcall_delta", contentIndex: 0, delta: text.slice(index, index + 32) });
		}
		proxyEvents.push(
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts", content } },
			},
			{ type: "done", reason: "toolUse", usage },
		);
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const started = performance.now();
		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		let shown = 0;
		let deltas = 0;
		for await (const event of stream) {
			if (event.type !== "toolcall_delta") continue;
			const block = event.partial.content[0];
			expect(Object.keys(block!).sort()).toEqual(["arguments", "id", "name", "type"]);
			const partial = block?.type === "toolCall" ? block.arguments.content : undefined;
			if (typeof partial !== "string") continue;
			// Comparing the whole text on every delta would make this test itself quadratic.
			if (deltas++ % 500 === 0) expect(content.startsWith(partial)).toBe(true);
			expect(partial.length).toBeGreaterThanOrEqual(shown);
			shown = partial.length;
		}
		const result = await stream.result();

		expect(shown).toBeGreaterThan(content.length - 64);
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts", content } },
		]);
		// Re-parsing the accumulated 520 KB of arguments on each of its 16,000 deltas took minutes.
		expect(performance.now() - started).toBeLessThan(10_000);
	});
});
