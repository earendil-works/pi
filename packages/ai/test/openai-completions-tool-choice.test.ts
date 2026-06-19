import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/index.ts";
import { getModel } from "../src/models.ts";
import { convertMessages } from "../src/providers/openai-completions.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, Tool, ToolResultMessage } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	chunks: undefined as
		| Array<null | {
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null; usage?: unknown }>;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					prompt_tokens_details: { cached_tokens: number; cache_write_tokens?: number };
					completion_tokens_details: { reasoning_tokens: number };
				};
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [
								{
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 1,
										completion_tokens: 1,
										prompt_tokens_details: { cached_tokens: 0 },
										completion_tokens_details: { reasoning_tokens: 0 },
									},
								},
							];
							for (const chunk of chunks) {
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

const localOpenAICompletionsModel = {
	api: "openai-completions",
	provider: "local-vllm",
	baseUrl: "http://localhost:8000/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
} satisfies Omit<Model<"openai-completions">, "id" | "name" | "compat">;

type CapturedParams = {
	chat_template_kwargs?: Record<string, unknown>;
	thinking?: unknown;
	reasoning_effort?: string;
};

async function captureSimpleParams(
	model: Model<"openai-completions">,
	reasoning?: SimpleStreamOptions["reasoning"],
): Promise<CapturedParams> {
	let payload: unknown;

	await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		},
		{
			apiKey: "test",
			reasoning,
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();

	return (payload ?? mockState.lastParams) as CapturedParams;
}

describe("openai-completions tool_choice", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = undefined;
	});

	it("forwards toolChoice from simple options to payload", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				toolChoice: "required",
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamSimple>[2],
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_choice?: string; tools?: unknown[] };
		expect(params.tool_choice).toBe("required");
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools?.length ?? 0).toBeGreaterThan(0);
	});

	it("omits strict when compat disables strict mode", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = {
			...baseModel,
			api: "openai-completions",
			compat: { supportsStrictMode: false },
		} as const;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamSimple>[2],
		).result();

		const params = (payload ?? mockState.lastParams) as { tools?: Array<{ function?: Record<string, unknown> }> };
		const tool = params.tools?.[0]?.function;
		expect(tool).toBeTruthy();
		expect(tool?.strict).toBeUndefined();
		expect("strict" in (tool ?? {})).toBe(false);
	});

	it("maps groq qwen3 reasoning levels to default reasoning_effort", async () => {
		const model = getModel("groq", "qwen/qwen3-32b")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBe("default");
	});

	it("keeps normal reasoning_effort for groq models without compat mapping", async () => {
		const model = getModel("groq", "openai/gpt-oss-20b")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBe("medium");
	});

	it("enables tool_stream for supported z.ai models with tools", async () => {
		const model = getModel("zai", "glm-5.1")!;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBe(true);
	});

	it("stores z.ai tool_stream support in model compat metadata", () => {
		expect(getModel("zai", "glm-5.1")?.compat?.zaiToolStream).toBe(true);
		expect(getModel("zai", "glm-4.7")?.compat?.zaiToolStream).toBe(true);
		expect(getModel("zai", "glm-4.7")?.compat?.zaiToolStream).toBe(true);
		expect(getModel("zai", "glm-5-turbo")?.compat?.zaiToolStream).toBe(true);
		expect(getModel("zai", "glm-4.5-air")?.compat?.zaiToolStream).toBeUndefined();
	});

	it("stores z.ai GLM-5.2 effort metadata", () => {
		for (const provider of ["zai", "zai-coding-cn"] as const) {
			const model = getModel(provider, "glm-5.2")!;
			expect(model.compat?.supportsReasoningEffort).toBe(true);
			expect(model.thinkingLevelMap).toEqual({
				minimal: null,
				low: "high",
				medium: "high",
				high: "high",
				xhigh: "max",
			});
		}
	});

	it("maps z.ai GLM-5.2 thinking levels to reasoning_effort", async () => {
		const model = getModel("zai", "glm-5.2")!;
		const cases = [
			{ reasoning: "low", effort: "high" },
			{ reasoning: "medium", effort: "high" },
			{ reasoning: "high", effort: "high" },
			{ reasoning: "xhigh", effort: "max" },
		] as const;

		for (const testCase of cases) {
			let payload: unknown;

			await streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Hi",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: "test",
					reasoning: testCase.reasoning,
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
			expect(params.thinking).toEqual({ type: "enabled" });
			expect(params.reasoning_effort).toBe(testCase.effort);
		}
	});

	it("omits z.ai GLM-5.2 reasoning_effort when thinking is off", async () => {
		const model = getModel("zai", "glm-5.2")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("omits tool_stream for unsupported z.ai models", async () => {
		const model = getModel("zai", "glm-4.5-air")!;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBeUndefined();
	});

	it("respects explicit z.ai tool_stream compat override", async () => {
		const baseModel = getModel("zai", "glm-4.5-air")!;
		const model = {
			...baseModel,
			compat: {
				...baseModel.compat,
				zaiToolStream: true,
			},
		} as const;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBe(true);
	});

	it("omits tool_stream when no tools are provided", async () => {
		const model = getModel("zai", "glm-5.1")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBeUndefined();
	});

	it("maps non-standard provider finish_reason values to stopReason error", async () => {
		mockState.chunks = [
			{
				choices: [{ delta: { content: "partial" }, finish_reason: null }],
			},
			{
				choices: [{ delta: {}, finish_reason: "network_error" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const model = getModel("zai", "glm-5.1")!;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("Provider finish_reason: network_error");
	});

	it("ignores null stream chunks from openai-compatible providers", async () => {
		mockState.chunks = [
			null,
			{
				id: "chatcmpl-test",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-test",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 3,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
		expect(response.responseId).toBe("chatcmpl-test");
		expect(response.usage.totalTokens).toBe(4);
		expect(response.content).toEqual([{ type: "text", text: "OK" }]);
	});

	it("errors when a stream ends after only null finish_reason chunks", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-truncated",
				choices: [{ delta: { content: "partial answer" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-truncated",
				choices: [{ delta: { content: "partial answer" }, finish_reason: null }],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with a longer sentence",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("Stream ended without finish_reason");
	});

	it("coalesces tool call deltas by stable index when provider mutates ids mid-stream", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "functions.read:0",
									type: "function",
									function: { name: "read", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "chatcmpl-tool-a",
									type: "function",
									function: { name: null, arguments: '{"path":"README' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "chatcmpl-tool-b",
									type: "function",
									function: { name: null, arguments: '.md"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
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
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};
		const s = streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Read README.md",
						timestamp: Date.now(),
					},
				],
				tools: [tool],
			},
			{ apiKey: "test" },
		);

		const toolCallContentIndexes: number[] = [];
		for await (const event of s) {
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
				toolCallContentIndexes.push(event.contentIndex);
			}
		}

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(toolCallContentIndexes).toEqual([0, 0, 0, 0, 0]);
		expect(response.content).toHaveLength(1);
		const toolCall = response.content[0];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type !== "toolCall") {
			throw new Error("Expected toolCall content");
		}
		expect(toolCall.id).toBe("functions.read:0");
		expect(toolCall.name).toBe("read");
		expect(toolCall.arguments).toEqual({ path: "README.md" });
		expect(toolCall).not.toHaveProperty("streamIndex");
		expect(toolCall).not.toHaveProperty("partialArgs");
	});

	it("accumulates mixed content, reasoning, and parallel tool call deltas independently", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: "answer 1",
							reasoning_content: "think 1",
							tool_calls: [
								{
									index: 0,
									id: "tc_read_initial",
									type: "function",
									function: { name: "read", arguments: '{"path":"README' },
								},
								{
									index: 1,
									id: "tc_grep_initial",
									type: "function",
									function: { name: "grep", arguments: '{"pattern":"TODO' },
								},
								{
									id: "tc_list_no_index",
									type: "function",
									function: { name: "list", arguments: '{"path":"packages' },
								},
								{
									id: "tc_write_no_index",
									type: "function",
									function: { name: "write", arguments: '{"path":"out' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: " answer 2",
							tool_calls: [
								{
									index: 1,
									id: "tc_grep_changed",
									type: "function",
									function: { arguments: '","path":"src' },
								},
								{
									id: "tc_write_no_index",
									type: "function",
									function: { arguments: '.txt","content":"ok"}' },
								},
								{
									id: "tc_list_no_index",
									type: "function",
									function: { arguments: '/ai"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: "\n",
							reasoning_content: " think 2",
							tool_calls: [
								{
									index: 0,
									id: "tc_read_changed",
									type: "function",
									function: { arguments: '.md"}' },
								},
								{
									index: 1,
									type: "function",
									function: { arguments: '"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 8,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 2 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tools: Tool[] = [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
			{
				name: "grep",
				description: "Search a file",
				parameters: Type.Object({ pattern: Type.String(), path: Type.String() }),
			},
			{
				name: "list",
				description: "List a directory",
				parameters: Type.Object({ path: Type.String() }),
			},
			{
				name: "write",
				description: "Write a file",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			},
		];
		const s = streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Think, answer, and use tools.",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{ apiKey: "test" },
		);

		const eventTypes: string[] = [];
		const toolEventsByContentIndex = new Map<number, string[]>();
		for await (const event of s) {
			eventTypes.push(event.type);
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
				const events = toolEventsByContentIndex.get(event.contentIndex) ?? [];
				events.push(event.type);
				toolEventsByContentIndex.set(event.contentIndex, events);
			}
		}

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(eventTypes.filter((type) => type === "text_start")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "text_delta")).toHaveLength(3);
		expect(eventTypes.filter((type) => type === "text_end")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "thinking_start")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "thinking_delta")).toHaveLength(2);
		expect(eventTypes.filter((type) => type === "thinking_end")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "toolcall_start")).toHaveLength(4);
		expect(eventTypes.filter((type) => type === "toolcall_delta")).toHaveLength(9);
		expect(eventTypes.filter((type) => type === "toolcall_end")).toHaveLength(4);
		expect(toolEventsByContentIndex.get(2)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(3)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(4)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(5)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);

		expect(response.content).toHaveLength(6);
		expect(response.content[0]).toEqual({ type: "text", text: "answer 1 answer 2\n" });
		expect(response.content[1]).toEqual({
			type: "thinking",
			thinking: "think 1 think 2",
			thinkingSignature: "reasoning_content",
		});
		const readCall = response.content[2];
		const grepCall = response.content[3];
		const listCall = response.content[4];
		const writeCall = response.content[5];
		expect(readCall.type).toBe("toolCall");
		expect(grepCall.type).toBe("toolCall");
		expect(listCall.type).toBe("toolCall");
		expect(writeCall.type).toBe("toolCall");
		if (
			readCall.type !== "toolCall" ||
			grepCall.type !== "toolCall" ||
			listCall.type !== "toolCall" ||
			writeCall.type !== "toolCall"
		) {
			throw new Error("Expected toolCall content");
		}
		expect(readCall.id).toBe("tc_read_initial");
		expect(readCall.name).toBe("read");
		expect(readCall.arguments).toEqual({ path: "README.md" });
		expect(readCall).not.toHaveProperty("streamIndex");
		expect(readCall).not.toHaveProperty("partialArgs");
		expect(grepCall.id).toBe("tc_grep_initial");
		expect(grepCall.name).toBe("grep");
		expect(grepCall.arguments).toEqual({ pattern: "TODO", path: "src" });
		expect(grepCall).not.toHaveProperty("streamIndex");
		expect(grepCall).not.toHaveProperty("partialArgs");
		expect(listCall.id).toBe("tc_list_no_index");
		expect(listCall.name).toBe("list");
		expect(listCall.arguments).toEqual({ path: "packages/ai" });
		expect(listCall).not.toHaveProperty("streamIndex");
		expect(listCall).not.toHaveProperty("partialArgs");
		expect(writeCall.id).toBe("tc_write_no_index");
		expect(writeCall.name).toBe("write");
		expect(writeCall.arguments).toEqual({ path: "out.txt", content: "ok" });
		expect(writeCall).not.toHaveProperty("streamIndex");
		expect(writeCall).not.toHaveProperty("partialArgs");
	});

	it("uses system messages for non-OpenAI/Anthropic OpenRouter reasoning model instructions", async () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4-pro")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				systemPrompt: "Follow instructions.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = payload as { messages?: Array<{ role?: string }> };
		expect(params.messages?.[0]?.role).toBe("system");
	});

	it("keeps developer messages for OpenAI and Anthropic OpenRouter reasoning model instructions", async () => {
		for (const model of [
			getModel("openrouter", "openai/gpt-5.2-codex"),
			getModel("openrouter", "anthropic/claude-sonnet-4.5"),
		]) {
			expect(model).toBeDefined();
			let payload: unknown;

			await streamSimple(
				model!,
				{
					systemPrompt: "Follow instructions.",
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test",
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = payload as { messages?: Array<{ role?: string }> };
			expect(params.messages?.[0]?.role).toBe("developer");
		}
	});

	it("keeps developer messages for OpenAI reasoning model instructions", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-5.5")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		let payload: unknown;

		await streamSimple(
			model,
			{
				systemPrompt: "Follow instructions.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = payload as { messages?: Array<{ role?: string }> };
		expect(params.messages?.[0]?.role).toBe("developer");
	});

	it("stores OpenRouter Kimi K2.6 reasoning replay compat in built-in metadata", () => {
		const model = getModel("openrouter", "moonshotai/kimi-k2.6")!;
		expect(model.compat?.supportsDeveloperRole).toBe(false);
		expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
	});

	it("stores Xiaomi MiMo reasoning replay compat in built-in metadata", () => {
		const providers = ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const;

		for (const provider of providers) {
			const model = getModel(provider, "mimo-v2.5-pro")!;
			expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
			expect(model.compat?.thinkingFormat).toBe("deepseek");
			expect(model.compat?.maxTokensField).toBeUndefined();
			expect(model.compat?.supportsDeveloperRole).toBeUndefined();
		}
	});

	it("replays Xiaomi MiMo assistant tool calls with empty reasoning_content when thinking is missing", async () => {
		const model = getModel("xiaomi", "mimo-v2.5-pro")!;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "xiaomi",
			model: "mimo-v2.5-pro",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "Read README.md", timestamp: Date.now() },
					assistantMessage,
					toolResult,
				],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			messages?: Array<Record<string, unknown>>;
			thinking?: { type?: string };
			reasoning_effort?: string;
		};
		const replayedAssistant = params.messages?.find((message) => message.role === "assistant");
		expect(replayedAssistant).toMatchObject({ role: "assistant", reasoning_content: "" });
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("high");
	});

	it("normalizes OpenCode Go reasoning deltas to reasoning_content for replay", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-opencode-go-reasoning",
				choices: [{ delta: { reasoning: "think" }, finish_reason: "stop" }],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("opencode-go", "kimi-k2.6")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Use reasoning.", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		expect(response.content).toEqual([
			{
				type: "thinking",
				thinking: "think",
				thinkingSignature: "reasoning_content",
			},
		]);
	});

	it("keeps non-OpenCode Go reasoning deltas on the original reasoning field", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-reasoning",
				choices: [{ delta: { reasoning: "think" }, finish_reason: "stop" }],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Use reasoning.", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		expect(response.content).toEqual([
			{
				type: "thinking",
				thinking: "think",
				thinkingSignature: "reasoning",
			},
		]);
	});

	it("replays OpenCode Go reasoning thinking blocks as reasoning_content", () => {
		const { compat: _compat, ...baseModel } = getModel("opencode-go", "kimi-k2.6")!;
		const model = { ...baseModel, api: "openai-completions" } as Model<"openai-completions">;
		const messages = convertMessages(
			model,
			{
				messages: [
					{
						role: "assistant",
						api: "openai-completions",
						provider: "opencode-go",
						model: "kimi-k2.6",
						content: [
							{ type: "thinking", thinking: "think", thinkingSignature: "reasoning" },
							{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
						],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			},
			{
				...model.compat,
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				supportsUsageInStreaming: true,
				maxTokensField: "max_completion_tokens",
				requiresToolResultName: false,
				requiresAssistantAfterToolResult: false,
				requiresThinkingAsText: false,
				requiresReasoningContentOnAssistantMessages: false,
				thinkingFormat: "openai",
				openRouterRouting: {},
				vercelGatewayRouting: {},
				chatTemplateKwargs: {},
				zaiToolStream: false,
				supportsStrictMode: true,
				sendSessionAffinityHeaders: false,
				supportsLongCacheRetention: true,
			},
		);

		expect(messages[0]).toMatchObject({ role: "assistant", reasoning_content: "think" });
		expect(messages[0]).not.toHaveProperty("reasoning");
	});

	it("sends thinking disabled for OpenCode Go Kimi K2.6 when thinking is off", async () => {
		const model = getModel("opencode-go", "kimi-k2.6")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("sends thinking enabled for OpenCode Go Kimi K2.6 when thinking is enabled", async () => {
		const model = getModel("opencode-go", "kimi-k2.6")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("omits disabled thinking for Moonshot Kimi K2.7 Code models", async () => {
		const cases = [getModel("moonshotai", "kimi-k2.7-code"), getModel("moonshotai-cn", "kimi-k2.7-code")];

		for (const model of cases) {
			expect(model).toBeDefined();
			let payload: unknown;

			await streamSimple(
				model!,
				{
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test",
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
			expect(params.thinking).toBeUndefined();
			expect(params.reasoning_effort).toBeUndefined();
		}
	});

	it("keeps disabled thinking for Moonshot Kimi K2.6 when thinking is off", async () => {
		const model = getModel("moonshotai-cn", "kimi-k2.6")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("sends max_tokens for OpenCode completions models", async () => {
		const cases = [getModel("opencode-go", "kimi-k2.6")!, getModel("opencode", "grok-build-0.1")!] as const;

		for (const model of cases) {
			let payload: unknown;
			expect(model.compat?.maxTokensField).toBe("max_tokens");

			await streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test",
					maxTokens: 123,
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = (payload ?? mockState.lastParams) as { max_tokens?: number; max_completion_tokens?: number };
			expect(params.max_tokens).toBe(123);
			expect(params.max_completion_tokens).toBeUndefined();
		}
	});

	it("omits reasoning effort for OpenCode Grok Build", async () => {
		const model = getModel("opencode", "grok-build-0.1")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("does not double-count reasoning tokens in completion usage", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-reasoning-usage",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 33,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 21 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Use reasoning.",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.usage.input).toBe(10);
		expect(response.usage.output).toBe(33);
		expect(response.usage.totalTokens).toBe(43);
	});

	it("preserves prompt_tokens_details cache read/write fields from chunk usage", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		// cached_tokens is documented as cache reads; cache_write_tokens is separate.
		expect(response.usage.input).toBe(20);
		expect(response.usage.cacheRead).toBe(50);
		expect(response.usage.cacheWrite).toBe(30);
		expect(response.usage.totalTokens).toBe(105);
	});

	it("preserves prompt_tokens_details cache read/write fields from choice usage fallback", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write-choice",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write-choice",
				choices: [
					{
						delta: {},
						finish_reason: "stop",
						usage: {
							prompt_tokens: 100,
							completion_tokens: 5,
							prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
							completion_tokens_details: { reasoning_tokens: 0 },
						},
					},
				],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		// cached_tokens is documented as cache reads; cache_write_tokens is separate.
		expect(response.usage.input).toBe(20);
		expect(response.usage.cacheRead).toBe(50);
		expect(response.usage.cacheWrite).toBe(30);
		expect(response.usage.totalTokens).toBe(105);
	});

	it("uses OpenRouter reasoning object instead of reasoning_effort", async () => {
		const model = getModel("openrouter", "deepseek/deepseek-r1")!;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			reasoning?: { effort?: string };
			reasoning_effort?: string;
		};
		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("uses configurable chat template boolean thinking kwargs", async () => {
		const model = {
			...localOpenAICompletionsModel,
			id: "deepseek-ai/DeepSeek-V3.1",
			name: "DeepSeek V3.1 via vLLM",
			compat: {
				thinkingFormat: "chat-template",
				supportsReasoningEffort: false,
				chatTemplateKwargs: { thinking: { $var: "thinking.enabled" } },
			},
		} satisfies Model<"openai-completions">;

		for (const testCase of [
			{ reasoning: "high" as const, expected: true },
			{ reasoning: undefined, expected: false },
		]) {
			const params = await captureSimpleParams(model, testCase.reasoning);

			expect(params.chat_template_kwargs).toEqual({ thinking: testCase.expected });
			expect(params.thinking).toBeUndefined();
			expect(params.reasoning_effort).toBeUndefined();
		}
	});

	it("uses qwen chat template thinking kwargs", async () => {
		const model = {
			...localOpenAICompletionsModel,
			id: "Qwen/Qwen3-Coder",
			name: "Qwen3 Coder via vLLM",
			compat: {
				thinkingFormat: "qwen-chat-template",
				supportsReasoningEffort: false,
			},
		} satisfies Model<"openai-completions">;

		for (const testCase of [
			{ reasoning: "high" as const, expected: true },
			{ reasoning: undefined, expected: false },
		]) {
			const params = await captureSimpleParams(model, testCase.reasoning);

			expect(params.chat_template_kwargs).toEqual({
				enable_thinking: testCase.expected,
				preserve_thinking: true,
			});
			expect(params.reasoning_effort).toBeUndefined();
		}
	});

	it("uses configurable chat template effort kwargs with static kwargs", async () => {
		const model = {
			...localOpenAICompletionsModel,
			id: "unsloth/gpt-oss-120b-GGUF",
			name: "GPT OSS via vLLM",
			thinkingLevelMap: { xhigh: "max" },
			compat: {
				thinkingFormat: "chat-template",
				supportsReasoningEffort: false,
				chatTemplateKwargs: {
					preserve_thinking: true,
					reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
				},
			},
		} satisfies Model<"openai-completions">;

		const params = await captureSimpleParams(model, "xhigh");

		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true, reasoning_effort: "max" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("uses Ant Ling compatibility metadata", async () => {
		const model = getModel("ant-ling", "Ring-2.6-1T")!;
		let payload: unknown;

		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "ant-ling",
			supportsLongCacheRetention: false,
		});
		expect(model.compat?.supportsStrictMode).toBeUndefined();
		expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBeUndefined();

		await streamSimple(
			model,
			{
				systemPrompt: "Follow instructions.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				maxTokens: 123,
				reasoning: "high",
				cacheRetention: "long",
				sessionId: "ant-ling-session",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			max_tokens?: number;
			max_completion_tokens?: number;
			messages?: Array<{ role?: string }>;
			reasoning?: { effort?: string };
			reasoning_effort?: string;
			store?: boolean;
			prompt_cache_key?: string;
			prompt_cache_retention?: string;
		};
		expect(params.max_tokens).toBe(123);
		expect(params.max_completion_tokens).toBeUndefined();
		expect(params.messages?.[0]?.role).toBe("system");
		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.store).toBeUndefined();
		expect(params.prompt_cache_key).toBeUndefined();
		expect(params.prompt_cache_retention).toBeUndefined();
	});

	it("omits Ant Ling reasoning for unmapped direct reasoning efforts and non-reasoning models", async () => {
		const ring = getModel("ant-ling", "Ring-2.6-1T")!;
		let payload: unknown;

		await stream(
			ring,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoningEffort: "medium",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		expect((payload ?? mockState.lastParams) as { reasoning?: unknown }).not.toHaveProperty("reasoning");

		const ling = getModel("ant-ling", "Ling-2.6-flash")!;
		await streamSimple(
			ling,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		expect((payload ?? mockState.lastParams) as { reasoning?: unknown }).not.toHaveProperty("reasoning");
	});
});
