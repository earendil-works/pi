import { describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.ts";
import type { Model } from "../src/types.ts";

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

// Built-in registry has no chat-template models yet (intended for custom providers),
// so build a Model<"openai-completions"> literal mirroring the built-in shape.
function chatTemplateModel(compat: NonNullable<Model<"openai-completions">["compat"]>): Model<"openai-completions"> {
	return {
		id: "test-chat-template",
		name: "Test Chat Template",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test/v1",
		compat,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

async function captureParams(model: Model<"openai-completions">, reasoning?: "off" | "high") {
	let payload: unknown;
	await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		},
		{
			apiKey: "test",
			// "off" is not a valid ThinkingLevel; map it to undefined so reasoningEffort
			// resolves to undefined (the disabled path) while satisfying the type system.
			reasoning: reasoning === "off" ? undefined : reasoning,
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();
	return (payload ?? mockState.lastParams) as {
		chat_template_kwargs?: Record<string, unknown>;
		thinking?: unknown;
	};
}

describe("chat-template thinkingFormat", () => {
	it("sends chat_template_kwargs.thinking boolean when reasoning is on (default key/mode)", async () => {
		const model = chatTemplateModel({ thinkingFormat: "chat-template" });
		const params = await captureParams(model, "high");
		expect(params.chat_template_kwargs).toEqual({ thinking: true });
		expect(params.thinking).toBeUndefined();
	});

	it("sends chat_template_kwargs.thinking = false when reasoning is off (boolean mode)", async () => {
		const model = chatTemplateModel({ thinkingFormat: "chat-template" });
		const params = await captureParams(model, "off");
		expect(params.chat_template_kwargs).toEqual({ thinking: false });
	});

	it("uses custom key name for enable_thinking-style templates", async () => {
		const model = chatTemplateModel({
			thinkingFormat: "chat-template",
			chatTemplateThinking: { key: "enable_thinking" },
		});
		const params = await captureParams(model, "high");
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
	});

	it("merges static chatTemplateKwargs", async () => {
		const model = chatTemplateModel({
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { preserve_thinking: true },
		});
		const params = await captureParams(model, "high");
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true, thinking: true });
	});

	it("sends mapped effort string in effort mode when reasoning is on", async () => {
		const model = chatTemplateModel({
			thinkingFormat: "chat-template",
			chatTemplateThinking: { key: "reasoning_effort", mode: "effort" },
		});
		model.thinkingLevelMap = { high: "high" };
		const params = await captureParams(model, "high");
		expect(params.chat_template_kwargs).toEqual({ reasoning_effort: "high" });
	});

	it("emits static kwargs without thinking key in effort mode when reasoning is off", async () => {
		const model = chatTemplateModel({
			thinkingFormat: "chat-template",
			chatTemplateThinking: { key: "reasoning_effort", mode: "effort" },
			chatTemplateKwargs: { preserve_thinking: true },
		});
		const params = await captureParams(model, "off");
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("omits chat_template_kwargs entirely in effort mode when reasoning is off and no static kwargs", async () => {
		const model = chatTemplateModel({
			thinkingFormat: "chat-template",
			chatTemplateThinking: { key: "reasoning_effort", mode: "effort" },
		});
		const params = await captureParams(model, "off");
		expect(params.chat_template_kwargs).toBeUndefined();
	});
});
