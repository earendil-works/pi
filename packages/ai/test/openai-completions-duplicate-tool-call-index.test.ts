import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Tool } from "../src/types.ts";

// Regression: some OpenAI-compatible providers violate the streaming contract by
// reusing the same `tool_calls[].index` for two *different* tool calls (distinct
// ids, distinct arguments). The block lookup used to key on stream index first,
// so the second call's argument fragments were silently appended to the first
// call's block, producing concatenated arguments like
//   {"command":"echo AAA"}{"command":"echo BBB"}
// which then fails downstream with
//   'Unexpected non-whitespace character after JSON at position N'.
// A collision guard must split the second call into its own toolCall block.

const mockState = vi.hoisted(() => ({
	chunks: undefined as
		| Array<{
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					prompt_tokens_details: { cached_tokens: number };
					completion_tokens_details: { reasoning_tokens: number };
				};
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (_params: unknown) => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks ?? []) {
								yield chunk;
							}
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

describe("openai-completions duplicate tool-call stream index", () => {
	it("splits two tool calls that illegally reuse the same stream index", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-dup-index",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_A",
									type: "function",
									function: { name: "bash", arguments: '{"command": "echo AAA"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-dup-index",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_B",
									type: "function",
									function: { name: "bash", arguments: '{"command": "echo BBB"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-dup-index",
				choices: [{ delta: {}, finish_reason: "tool_calls" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tool: Tool = {
			name: "bash",
			description: "Run a shell command",
			parameters: Type.Object({ command: Type.String() }),
		};
		const s = streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Run two commands", timestamp: Date.now() }],
				tools: [tool],
			},
			{ apiKey: "test" },
		);

		let toolCallStarts = 0;
		let toolCallEnds = 0;
		for await (const event of s) {
			if (event.type === "toolcall_start") toolCallStarts++;
			if (event.type === "toolcall_end") toolCallEnds++;
		}

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(toolCallStarts).toBe(2);
		expect(toolCallEnds).toBe(2);
		expect(response.content).toHaveLength(2);

		const first = response.content[0];
		const second = response.content[1];
		expect(first.type).toBe("toolCall");
		expect(second.type).toBe("toolCall");
		if (first.type !== "toolCall" || second.type !== "toolCall") {
			throw new Error("Expected toolCall content");
		}
		expect(first.id).toBe("call_A");
		expect(first.name).toBe("bash");
		expect(first.arguments).toEqual({ command: "echo AAA" });
		expect(second.id).toBe("call_B");
		expect(second.name).toBe("bash");
		expect(second.arguments).toEqual({ command: "echo BBB" });
		expect(JSON.parse(JSON.stringify(first.arguments))).toEqual(first.arguments);
	});
});
