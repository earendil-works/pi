import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { applyReportedCost } from "../src/models.ts";
import type { AssistantMessage, Model, Usage } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunkSets: [] as unknown[][],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunkSets.shift() ?? [];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function makeUsage(cost: Usage["cost"]): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 200,
		cacheWrite: 0,
		totalTokens: 350,
		cost,
	};
}

describe("applyReportedCost", () => {
	it("scales components so they keep summing to the reported total", () => {
		const usage = makeUsage({ input: 0.5, output: 0.25, cacheRead: 0.25, cacheWrite: 0, total: 1 });
		applyReportedCost(usage, 2);
		expect(usage.cost.input).toBeCloseTo(1);
		expect(usage.cost.output).toBeCloseTo(0.5);
		expect(usage.cost.cacheRead).toBeCloseTo(0.5);
		expect(usage.cost.total).toBe(2);
	});

	it("sets only the total when local rates are all zero", () => {
		const usage = makeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		applyReportedCost(usage, 0.0042);
		expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 });
	});

	it("zeroes everything when the reported total is zero (BYOK)", () => {
		const usage = makeUsage({ input: 0.5, output: 0.25, cacheRead: 0.25, cacheWrite: 0, total: 1 });
		applyReportedCost(usage, 0);
		expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});

	it("ignores non-finite and negative values", () => {
		const usage = makeUsage({ input: 0.5, output: 0.25, cacheRead: 0.25, cacheWrite: 0, total: 1 });
		applyReportedCost(usage, Number.NaN);
		applyReportedCost(usage, -1);
		expect(usage.cost.total).toBe(1);
	});
});

function gatewayCompletionsModel(cost: Model<"openai-completions">["cost"]): Model<"openai-completions"> {
	return {
		id: "moonshotai/kimi-k3",
		name: "Kimi K3",
		api: "openai-completions",
		provider: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 262144,
		maxTokens: 131072,
	};
}

describe("openai-completions reported cost", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
	});

	it("uses usage.cost from the final chunk on a model without catalog rates", async () => {
		mockState.chunkSets = [
			[
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
				},
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [],
					usage: {
						prompt_tokens: 91,
						completion_tokens: 38,
						prompt_tokens_details: { cached_tokens: 91 },
						cost: 0.0005973,
					},
				},
			],
		];

		const model = gatewayCompletionsModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const message = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		).result();

		expect(message.usage.cost.total).toBe(0.0005973);
	});

	it("scales catalog-derived components to the reported total", async () => {
		mockState.chunkSets = [
			[
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
				},
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [],
					usage: { prompt_tokens: 1000, completion_tokens: 1000, cost: 0.036 },
				},
			],
		];

		// Local calc: 1000 * 3/M + 1000 * 15/M = 0.018, half the reported total.
		const model = gatewayCompletionsModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		const message = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		).result();

		expect(message.usage.cost.total).toBe(0.036);
		expect(message.usage.cost.input).toBeCloseTo(0.006);
		expect(message.usage.cost.output).toBeCloseTo(0.03);
	});

	it("adds upstream_inference_cost for BYOK requests", async () => {
		mockState.chunkSets = [
			[
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
				},
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [],
					usage: {
						prompt_tokens: 1000,
						completion_tokens: 1000,
						cost: 0,
						is_byok: true,
						cost_details: { upstream_inference_cost: 0.012 },
					},
				},
			],
		];

		const model = gatewayCompletionsModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const message = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		).result();

		expect(message.usage.cost.total).toBe(0.012);
	});

	it("ignores upstream_inference_cost for non-BYOK responses", async () => {
		mockState.chunkSets = [
			[
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
				},
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [],
					usage: {
						prompt_tokens: 1000,
						completion_tokens: 1000,
						cost: 0.018,
						is_byok: false,
						cost_details: { upstream_inference_cost: 0.018 },
					},
				},
			],
		];

		const model = gatewayCompletionsModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const message = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		).result();

		expect(message.usage.cost.total).toBe(0.018);
	});

	it("keeps the local calculation when no cost is reported", async () => {
		mockState.chunkSets = [
			[
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
				},
				{
					id: "gen_test",
					model: "moonshotai/kimi-k3",
					choices: [],
					usage: { prompt_tokens: 1000, completion_tokens: 1000 },
				},
			],
		];

		const model = gatewayCompletionsModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		const message = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		).result();

		expect(message.usage.cost.total).toBeCloseTo(0.018);
	});
});

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

function gatewayAnthropicModel(cost: Model<"anthropic-messages">["cost"]): Model<"anthropic-messages"> {
	return {
		id: "moonshotai/kimi-k3",
		name: "Kimi K3",
		api: "anthropic-messages",
		provider: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 262144,
		maxTokens: 131072,
	};
}

function kimiSseEvents(gatewayCost: string): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "gen_test",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_input_tokens: 91,
						cache_creation_input_tokens: 0,
					},
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			}),
		},
		{
			event: "content_block_stop",
			data: JSON.stringify({ type: "content_block_stop", index: 0 }),
		},
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 100 },
				provider_metadata: { gateway: { cost: gatewayCost } },
			}),
		},
		{
			event: "message_stop",
			data: JSON.stringify({ type: "message_stop" }),
		},
	];
}

async function runAnthropicStream(model: Model<"anthropic-messages">, gatewayCost: string): Promise<AssistantMessage> {
	return await streamAnthropic(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ client: createFakeAnthropicClient(createSseResponse(kimiSseEvents(gatewayCost))) },
	).result();
}

describe("anthropic-messages reported cost", () => {
	it("uses provider_metadata.gateway.cost from the final message_delta", async () => {
		const model = gatewayAnthropicModel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const message = await runAnthropicStream(model, "0.0015273");
		expect(message.usage.cost.total).toBe(0.0015273);
	});

	it("scales catalog-derived components to the reported total", async () => {
		// Local calc: 91 cacheRead * 0.3/M + 100 output * 15/M = 0.0015273, half the reported total.
		const model = gatewayAnthropicModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		const message = await runAnthropicStream(model, "0.0030546");
		expect(message.usage.cost.total).toBe(0.0030546);
		expect(message.usage.cost.cacheRead).toBeCloseTo(0.0000546);
		expect(message.usage.cost.output).toBeCloseTo(0.003);
	});

	it("keeps the local calculation when the reported value is invalid", async () => {
		const model = gatewayAnthropicModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		const message = await runAnthropicStream(model, "not-a-number");
		expect(message.usage.cost.total).toBeCloseTo(0.0015273);
	});
});
