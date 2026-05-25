import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { complete } from "../src/stream.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
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

function sumCost(cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }) {
	return cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

function expectCostSumToMatchTotal(cost: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}) {
	expect(Math.abs(sumCost(cost) - cost.total)).toBeLessThan(1e-9);
}

function openRouterModel(): Model<"openai-completions"> {
	return getModel("openrouter", "google/gemini-2.5-flash");
}

function openRouterModelWithCompat(): Model<"openai-completions"> {
	const model = openRouterModel();
	return {
		...model,
		compat: {
			...model.compat,
			openRouterReconcileCostFromGenerationEndpoint: true,
		},
	};
}

function nonOpenRouterCompletionsModel(): Model<"openai-completions"> {
	return {
		...openRouterModel(),
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		id: "grok-3-mini",
		name: "Grok 3 Mini",
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("openrouter cost inclusion", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("uses OpenRouter streamed usage.cost when present", async () => {
		mockState.chunks = [
			{
				id: "gen-streamed-cost",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			},
			{
				id: "gen-streamed-cost",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.stopReason).toBe("stop");
		expect(message.responseId).toBe("gen-streamed-cost");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.usage.cost.source).toBe("provider");
		expectCostSumToMatchTotal(message.usage.cost);
	});

	it("falls back to pi table pricing when OpenRouter omits cost", async () => {
		mockState.chunks = [
			{
				id: "gen-no-cost",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			},
			{
				id: "gen-no-cost",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const model = openRouterModel();
		const message = await complete(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const expectedInput = (model.cost.input / 1_000_000) * 100;
		const expectedOutput = (model.cost.output / 1_000_000) * 50;
		expect(message.usage.cost.source).toBe("pi");
		expect(message.usage.cost.input).toBe(expectedInput);
		expect(message.usage.cost.output).toBe(expectedOutput);
		expect(message.usage.cost.total).toBe(expectedInput + expectedOutput);
	});

	it("ignores provider cost fields for non-OpenRouter providers", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-non-openrouter",
				model: "gpt-4o-mini",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-non-openrouter",
				model: "gpt-4o-mini",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 10,
					cost: 0.5,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const model = nonOpenRouterCompletionsModel();
		const message = await complete(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const expectedInput = (model.cost.input / 1_000_000) * 20;
		const expectedOutput = (model.cost.output / 1_000_000) * 10;
		expect(message.usage.cost.source).toBe("pi");
		expect(message.usage.cost.total).toBe(expectedInput + expectedOutput);
		expect(message.usage.cost.total).not.toBe(0.5);
	});

	it("puts the entire provider total into input when streamed usage has zero tokens", async () => {
		mockState.chunks = [
			{
				id: "gen-zero-tokens",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 0,
					completion_tokens: 0,
					cost: 1.23e-6,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.input).toBe(1.23e-6);
		expect(message.usage.cost.output).toBe(0);
		expect(message.usage.cost.cacheRead).toBe(0);
		expect(message.usage.cost.cacheWrite).toBe(0);
		expect(message.usage.cost.total).toBe(1.23e-6);
	});

	it("reconciles OpenRouter cost from the generation endpoint", async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: { total_cost: 0.5 } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		mockState.chunks = [
			{
				id: "gen-reconcile-success",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			},
			{
				id: "gen-reconcile-success",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.total).toBe(0.5);
		expectCostSumToMatchTotal(message.usage.cost);
	});

	it("retries once after a 404 generation lookup", async () => {
		vi.useFakeTimers();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("not ready", { status: 404 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: { total_cost: 0.5 } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		mockState.chunks = [
			{
				id: "gen-retry-404",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(message.usage.cost.total).toBe(0.5);
		expectCostSumToMatchTotal(message.usage.cost);
	});

	it("skips generation reconciliation when responseId is not a gen id", async () => {
		vi.useFakeTimers();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		mockState.chunks = [
			{
				id: "chatcmpl-not-gen",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(message.responseId).toBe("chatcmpl-not-gen");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.usage.cost.source).toBe("provider");
	});

	it("keeps streamed provider cost and records a diagnostic when reconciliation fails", async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("server error", { status: 500 }))
			.mockResolvedValueOnce(new Response("server error", { status: 500 }));
		mockState.chunks = [
			{
				id: "gen-reconcile-fail",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.usage.cost.source).toBe("provider");
		expect(message.diagnostics?.[0]?.type).toBe("openrouter_cost_reconcile_failed");
		expect(message.diagnostics?.[0]?.details?.category).toBe("http_500");
	});
});
