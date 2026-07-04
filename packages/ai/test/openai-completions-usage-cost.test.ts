import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

interface CapturedCompletionsPayload {
	usage?: { include: boolean };
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedCompletionsPayload | undefined,
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedCompletionsPayload) => {
					mockState.lastParams = params;
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
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

function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return {
		...(baseModel as Omit<Model<"openai-completions">, "api">),
		api: "openai-completions",
		...overrides,
	};
}

async function captureRequest(model: Model<"openai-completions">) {
	await streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test-key" },
	).result();

	return mockState.lastParams;
}

describe("openai-completions usage accounting cost", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = [
			{
				id: "chatcmpl-test",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];
	});

	it("requests usage accounting for OpenRouter models", async () => {
		const model = createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
		const payload = await captureRequest(model);

		expect(payload?.usage).toEqual({ include: true });
	});

	it("does not request usage accounting for plain OpenAI models", async () => {
		const payload = await captureRequest(createModel());

		expect(payload?.usage).toBeUndefined();
	});

	it("uses provider-reported cost when present", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-test",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
					cost: 0.0123,
				},
			},
		];
		const model = createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });

		const message = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		).result();

		expect(message.usage.cost.total).toBe(0.0123);
	});

	it("leaves registry-computed cost untouched when cost is absent", async () => {
		const model = createModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			cost: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
		});

		const message = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		).result();

		expect(message.usage.cost.total).toBe(1);
	});
});
