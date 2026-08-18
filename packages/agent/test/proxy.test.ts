import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
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
});
