import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{
									delta: {
										content: '{\n  "name": "echo",\n  "arguments": {\n    "text": "hello"\n  }\n}',
									},
									finish_reason: "stop",
								}],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

const echoTool: Tool = {
	name: "echo",
	description: "Echo text",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
};

describe("openai-completions content tool-call recovery", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("recovers tool JSON emitted in content when tool_calls is empty", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		const response = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "call echo", timestamp: Date.now() }],
				tools: [echoTool],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("toolUse");
		expect(response.content).toEqual([
			{
				type: "toolCall",
				id: expect.stringMatching(/^recovered_echo_/),
				name: "echo",
				arguments: { text: "hello" },
			},
		]);
	});
});
