import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { builtinModels, getBuiltinModel } from "../src/providers/all.ts";
import type { Context, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context: Context = {
	systemPrompt: "Use the weather tool.",
	messages: [{ role: "user", content: "Weather in Paris?", timestamp: 0 }],
	tools: [{ name: "weather", description: "Look up weather", parameters: Type.Object({ city: Type.String() }) }],
};

function longcatModel(): Model<"openai-completions"> {
	const model = builtinModels().getModel("longcat", "LongCat-2.5");
	expect(model, "LongCat-2.5 must be built in").toBeDefined();
	return model as Model<"openai-completions">;
}

function sse(chunks: unknown[]): Response {
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
	return {
		id: "chatcmpl-longcat",
		object: "chat.completion.chunk",
		created: 1,
		model: "LongCat-2.5",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

// Provider integration requested in https://github.com/earendil-works/pi/issues/9308.
describe("LongCat provider", () => {
	it("lists the current model with binary thinking and published prices", () => {
		const model = longcatModel();
		expect(
			builtinModels()
				.getModels("longcat")
				.map((entry) => entry.id),
		).toEqual(["LongCat-2.5"]);
		expect(model).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.longcat.chat/openai/v1",
			input: ["text", "image"],
			inputLimits: { images: { maxPerRequest: 50 } },
			contextWindow: 1048576,
			maxTokens: 262144,
			cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
	});

	it("discovers LONGCAT_API_KEY and prefers the stored credential", async () => {
		const env = { LONGCAT_API_KEY: "test-env-key" };
		const credentials = new InMemoryCredentialStore();
		const models = builtinModels({
			credentials,
			authContext: { env: async (name) => env[name as keyof typeof env], fileExists: async () => false },
		});
		expect(findEnvKeys("longcat", env)).toEqual(["LONGCAT_API_KEY"]);
		expect(getEnvApiKey("longcat", env)).toBe("test-env-key");
		expect(await models.getAuth("longcat")).toMatchObject({
			auth: { apiKey: "test-env-key" },
			source: "LONGCAT_API_KEY",
		});
		expect((await models.getAvailable("longcat")).map((model) => model.id)).toEqual(["LongCat-2.5"]);
		await credentials.modify("longcat", async () => ({ type: "api_key", key: "test-stored-key" }));
		expect(await models.getAuth("longcat")).toMatchObject({ auth: { apiKey: "test-stored-key" } });
	});

	it("keeps an unconfigured provider unavailable and supports API key login", async () => {
		const models = builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		expect(models.getProvider("longcat")?.name).toBe("LongCat");
		expect(await models.getAvailable("longcat")).toEqual([]);
		await models.login("longcat", "api_key", {
			signal: new AbortController().signal,
			prompt: async (prompt) => {
				expect(prompt.type).toBe("secret");
				return "test-login-key";
			},
			notify: () => {},
		});
		expect(await models.getAuth("longcat")).toMatchObject({ auth: { apiKey: "test-login-key" } });
	});

	it.each([undefined, "high"] as const)("sends the documented request for thinking %s", async (reasoning) => {
		const model = longcatModel();
		const requests: Request[] = [];
		const bodies: Record<string, unknown>[] = [];
		const fetch: FetchFunction = async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			bodies.push((await request.json()) as Record<string, unknown>);
			return sse([chunk({ content: "ok" }, "stop")]);
		};
		const models = builtinModels({
			authContext: {
				env: async (name) => (name === "LONGCAT_API_KEY" ? "test-key" : undefined),
				fileExists: async () => false,
			},
		});
		const result = await models.completeSimple(model, context, {
			fetch,
			reasoning,
			maxTokens: 1024,
			temperature: 0.7,
			cacheRetention: "long",
			sessionId: "test-session",
		});
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://api.longcat.chat/openai/v1/chat/completions");
		expect(requests[0].headers.get("Authorization")).toBe("Bearer test-key");
		expect(bodies[0]).toMatchObject({
			model: "LongCat-2.5",
			stream: true,
			max_tokens: 1024,
			temperature: 0.7,
			stream_options: { include_usage: true },
			thinking: { type: reasoning ? "enabled" : "disabled" },
			messages: [
				{ role: "system", content: context.systemPrompt },
				{ role: "user", content: "Weather in Paris?" },
			],
		});
		for (const field of [
			"store",
			"max_completion_tokens",
			"reasoning_effort",
			"prompt_cache_key",
			"prompt_cache_retention",
		]) {
			expect(bodies[0]).not.toHaveProperty(field);
		}
		expect(bodies[0].tools).toEqual([
			{
				type: "function",
				function: { name: "weather", description: "Look up weather", parameters: context.tools![0].parameters },
			},
		]);
	});

	it.each(["finish", "trailing"])(
		"assembles null continuation deltas and accounts for %s usage",
		async (usagePosition) => {
			const model = longcatModel();
			const usage = {
				prompt_tokens: 100,
				completion_tokens: 12,
				total_tokens: 112,
				prompt_tokens_details: { cached_tokens: 20 },
				completion_tokens_details: { reasoning_tokens: 8 },
			};
			// LongCat repeats id/name as null on continuation chunks and can begin with empty reasoning.
			const chunks = [
				chunk({ role: "assistant", content: "", reasoning_content: "" }),
				chunk({ reasoning_content: "Check the weather." }),
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call_weather",
							type: "function",
							function: { name: "weather", arguments: '{"city":' },
						},
					],
				}),
				chunk({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '"Paris"}' } }] }),
				{ ...chunk({}, "tool_calls"), ...(usagePosition === "finish" ? { usage } : {}) },
				...(usagePosition === "trailing" ? [{ ...chunk({}), choices: [], usage }] : []),
			];
			const stream = streamSimple(model, normalizeContext(context), {
				apiKey: "test-key",
				reasoning: "high",
				fetch: async () => sse(chunks),
			});
			const events: string[] = [];
			for await (const event of stream) events.push(event.type);
			const response = await stream.result();
			expect(response.stopReason).toBe("toolUse");
			expect(response.content).toEqual([
				{ type: "thinking", thinking: "Check the weather.", thinkingSignature: "reasoning_content" },
				{ type: "toolCall", id: "call_weather", name: "weather", arguments: { city: "Paris" } },
			]);
			expect(events.filter((event) => event === "thinking_start")).toHaveLength(1);
			expect(events.at(-1)).toBe("done");
			expect(response.usage).toMatchObject({
				input: 80,
				output: 12,
				cacheRead: 20,
				cacheWrite: 0,
				reasoning: 8,
				totalTokens: 112,
			});
			expect(response.usage.cost.total).toBeCloseTo((80 * 0.3 + 20 * 0.006 + 12 * 1.2) / 1_000_000, 10);

			const replay: Context = {
				...context,
				messages: [
					...context.messages,
					response,
					{
						role: "toolResult",
						toolCallId: "call_weather",
						toolName: "weather",
						content: [{ type: "text", text: "Sunny" }],
						isError: false,
						timestamp: 1,
					},
					{ role: "user", content: "Summarize that.", timestamp: 2 },
				],
			};
			let payload: Record<string, unknown> | undefined;
			const continuation = await streamSimple(model, normalizeContext(replay), {
				apiKey: "test-key",
				reasoning: "high",
				fetch: async (input, init) => {
					payload = (await new Request(input, init).json()) as Record<string, unknown>;
					return sse([chunk({ content: "Sunny in Paris." }, "stop")]);
				},
			}).result();
			expect(continuation.stopReason).toBe("stop");
			const messages = payload?.messages as Record<string, unknown>[];
			expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
			expect(messages[2]).toMatchObject({
				content: "",
				reasoning_content: "Check the weather.",
				tool_calls: [{ id: "call_weather", function: { name: "weather", arguments: '{"city":"Paris"}' } }],
			});
		},
	);

	it("serializes image input with the OpenAI image_url format", async () => {
		const model = longcatModel();
		let payload: Record<string, unknown> | undefined;
		const response = await streamSimple(
			model,
			normalizeContext({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Describe this image." },
							{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
						],
						timestamp: 0,
					},
				],
			}),
			{
				apiKey: "test-key",
				fetch: async (input, init) => {
					payload = (await new Request(input, init).json()) as Record<string, unknown>;
					return sse([chunk({ content: "A picture." }, "stop")]);
				},
			},
		).result();
		expect(response.stopReason).toBe("stop");
		expect(payload?.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this image." },
					{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
				],
			},
		]);
	});
});

describe("assistant content compatibility", () => {
	it.each([true, false, undefined])(
		"uses an empty string only when required (%s)",
		async (requiresAssistantContentString) => {
			const base = getBuiltinModel("openai", "gpt-4o");
			const model: Model<"openai-completions"> = {
				...base,
				api: "openai-completions",
				compat: { requiresAssistantContentString },
			};
			const messages: Context = {
				...context,
				messages: [
					...context.messages,
					{
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [{ type: "toolCall", id: "call_weather", name: "weather", arguments: { city: "Paris" } }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 1,
					},
					{
						role: "toolResult",
						toolCallId: "call_weather",
						toolName: "weather",
						content: [{ type: "text", text: "Sunny" }],
						isError: false,
						timestamp: 2,
					},
				],
			};
			let payload: Record<string, unknown> | undefined;
			const result = await streamSimple(model, normalizeContext(messages), {
				apiKey: "test-key",
				fetch: async (input, init) => {
					payload = (await new Request(input, init).json()) as Record<string, unknown>;
					return sse([chunk({ content: "ok" }, "stop")]);
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			const assistant = (payload?.messages as Record<string, unknown>[]).find(
				(message) => message.role === "assistant",
			);
			expect(assistant?.content).toBe(requiresAssistantContentString ? "" : null);
		},
	);
});
