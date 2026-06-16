import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";

// Empty tools arrays must NOT be serialized as `tools: []` — some OpenAI-compatible
// backends (e.g. DashScope / Aliyun Qwen via compatible-mode) reject the request with
// `"[] is too short - 'tools'"` (HTTP 400) when `--no-tools` produces an empty array.
// Regression for https://github.com/earendil-works/pi-mono/issues/<issue-number>

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastClientOptions: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}

		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
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

describe("openai-completions empty tools handling", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastClientOptions = undefined;
	});

	it("omits tools field when context.tools is an empty array", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown };
		expect("tools" in (params as object)).toBe(false);
	});

	it("omits tools field when context.tools is undefined", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown };
		expect("tools" in (params as object)).toBe(false);
	});

	it("does not send default max token fields", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		expect(params.max_completion_tokens).toBeUndefined();
	});

	it("sends explicit maxTokens", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", maxTokens: 1234 },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		expect(params.max_completion_tokens).toBe(1234);
	});

	it("uses conservative OpenAI-compatible fields for Cloudflare AI Gateway /compat models", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const model = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

		await streamSimple(
			model,
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", maxTokens: 1234, reasoning: "high" },
		).result();

		const params = mockState.lastParams as {
			messages: Array<{ role: string }>;
			max_tokens?: number;
			max_completion_tokens?: number;
			reasoning_effort?: string;
			store?: boolean;
		};
		expect(params.messages[0].role).toBe("system");
		expect(params.max_tokens).toBe(1234);
		expect(params.max_completion_tokens).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.store).toBeUndefined();

		const clientOptions = mockState.lastClientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/compat");
		expect(clientOptions.defaultHeaders?.Authorization).toBeNull();
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer test");
	});

	it("uses provider env before process.env for Cloudflare AI Gateway base URL", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "process-account";
		process.env.CLOUDFLARE_GATEWAY_ID = "process-gateway";
		const model = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				env: {
					CLOUDFLARE_ACCOUNT_ID: "provider-account",
					CLOUDFLARE_GATEWAY_ID: "provider-gateway",
				},
			},
		).result();

		const clientOptions = mockState.lastClientOptions as { baseURL?: string };
		expect(clientOptions.baseURL).toBe(
			"https://gateway.ai.cloudflare.com/v1/provider-account/provider-gateway/compat",
		);
	});

	it("preserves inline upstream Authorization for Cloudflare AI Gateway BYOK requests", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const model = getModel("cloudflare-ai-gateway", "gpt-5.1")!;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "cf-token", headers: { Authorization: "Bearer upstream-token" } },
		).result();

		const clientOptions = mockState.lastClientOptions as { defaultHeaders?: Record<string, unknown> };
		expect(clientOptions.defaultHeaders?.Authorization).toBe("Bearer upstream-token");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer cf-token");
	});

	it("sends session affinity headers for Workers AI through Cloudflare AI Gateway", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const workersModel = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

		await streamSimple(
			workersModel,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", sessionId: "session-1" },
		).result();

		const clientOptions = mockState.lastClientOptions as { defaultHeaders?: Record<string, string> };
		expect(clientOptions.defaultHeaders?.session_id).toBe("session-1");
		expect(clientOptions.defaultHeaders?.["x-client-request-id"]).toBe("session-1");
		expect(clientOptions.defaultHeaders?.["x-session-affinity"]).toBe("session-1");
	});

	it("still emits tools: [] for Anthropic/LiteLLM proxy when conversation has tool history", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "use the tool", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "t1",
								name: "noop",
								arguments: {},
							},
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
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "t1",
						toolName: "noop",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown[] };
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools).toEqual([]);
	});
});
