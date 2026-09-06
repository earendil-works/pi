import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

interface FakeUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	completion_tokens_details?: { reasoning_tokens?: number };
	reasoning_tokens?: number;
}

const mockState = vi.hoisted(() => ({
	usage: undefined as FakeUsage | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: mockState.usage,
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

describe("openai-completions usage parsing", () => {
	beforeEach(() => {
		mockState.usage = undefined;
	});

	function createModel(): Model<"openai-completions"> {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		return {
			...(baseModel as Omit<Model<"openai-completions">, "api">),
			api: "openai-completions",
		};
	}

	async function captureUsage(usage: FakeUsage) {
		mockState.usage = usage;
		const message = await streamOpenAICompletions(
			createModel(),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key" },
		).result();
		return message.usage;
	}

	it("reads reasoning tokens from completion_tokens_details", async () => {
		const usage = await captureUsage({
			prompt_tokens: 10,
			completion_tokens: 20,
			completion_tokens_details: { reasoning_tokens: 7 },
		});

		expect(usage.reasoning).toBe(7);
	});

	it("falls back to top-level reasoning_tokens when details are omitted (LLM Gateway)", async () => {
		const usage = await captureUsage({
			prompt_tokens: 10,
			completion_tokens: 20,
			reasoning_tokens: 5,
		});

		expect(usage.reasoning).toBe(5);
	});

	it("reports zero reasoning tokens when neither field is present", async () => {
		const usage = await captureUsage({
			prompt_tokens: 10,
			completion_tokens: 20,
		});

		expect(usage.reasoning).toBe(0);
	});
});
