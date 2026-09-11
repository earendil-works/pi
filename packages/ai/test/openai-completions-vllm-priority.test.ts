import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

interface CapturedCompletionsPayload {
	priority?: number;
	[key: string]: unknown;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedCompletionsPayload | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedCompletionsPayload) => {
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
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key" },
	).result();

	return mockState.lastParams;
}

describe("openai-completions vllm priority", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends compat.vllmPriority as the top-level priority request field", async () => {
		const payload = await captureRequest(
			createModel({ compat: { vllmPriority: 10 } as Model<"openai-completions">["compat"] }),
		);

		expect(payload?.priority).toBe(10);
	});

	it("omits priority when vllmPriority is not set", async () => {
		const payload = await captureRequest(createModel());

		expect(payload?.priority).toBeUndefined();
	});
});
