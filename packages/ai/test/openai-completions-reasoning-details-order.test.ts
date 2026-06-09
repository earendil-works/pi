import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Model, Tool, ToolCall } from "../src/types.ts";

// Regression for #5114: when a provider streams `reasoning_details` (an
// encrypted reasoning signature whose `id` matches an upcoming tool call)
// BEFORE the `tool_calls` chunk, the signature must still be attached to the
// tool call. The pre-fix code looked the tool call up in `output.content` at
// the moment the reasoning_details chunk arrived; since the tool call did not
// exist yet, the signature was silently dropped and never round-tripped.

const mockState = vi.hoisted(() => ({
	chunks: undefined as Array<unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
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

const USAGE = {
	prompt_tokens: 1,
	completion_tokens: 1,
	prompt_tokens_details: { cached_tokens: 0 },
	completion_tokens_details: { reasoning_tokens: 0 },
};

function createModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	return { ...baseModel, api: "openai-completions" } as Model<"openai-completions">;
}

const tools: Tool[] = [
	{
		name: "ping",
		description: "Ping tool",
		parameters: Type.Object({ ok: Type.Boolean() }),
	},
];

const reasoningDetail = {
	type: "reasoning.encrypted",
	id: "call_abc",
	data: "opaque-encrypted-signature",
};

async function run(): Promise<ToolCall | undefined> {
	const response = await streamSimple(
		createModel(),
		{
			messages: [{ role: "user", content: "Call ping with ok=true", timestamp: Date.now() }],
			tools,
		},
		{ apiKey: "test" },
	).result();
	return response.content.find((b): b is ToolCall => b.type === "toolCall" && b.id === "call_abc") as
		| ToolCall
		| undefined;
}

describe("openai-completions reasoning_details ordering (#5114)", () => {
	beforeEach(() => {
		mockState.chunks = undefined;
	});

	it("attaches the signature when reasoning_details arrives BEFORE the tool_call", async () => {
		mockState.chunks = [
			// reasoning_details first — the tool call does not exist yet
			{ choices: [{ delta: { reasoning_details: [reasoningDetail] }, finish_reason: null }] },
			// tool_call arrives afterwards
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "call_abc", function: { name: "ping", arguments: '{"ok":true}' } }],
						},
						finish_reason: null,
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: USAGE },
		];

		const toolCall = await run();
		expect(toolCall).toBeDefined();
		expect(toolCall?.thoughtSignature).toBe(JSON.stringify(reasoningDetail));
	});

	it("still attaches the signature when reasoning_details arrives AFTER the tool_call", async () => {
		mockState.chunks = [
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "call_abc", function: { name: "ping", arguments: '{"ok":true}' } }],
						},
						finish_reason: null,
					},
				],
			},
			{ choices: [{ delta: { reasoning_details: [reasoningDetail] }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: USAGE },
		];

		const toolCall = await run();
		expect(toolCall).toBeDefined();
		expect(toolCall?.thoughtSignature).toBe(JSON.stringify(reasoningDetail));
	});
});
