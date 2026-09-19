import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, normalizeContext } from "../src/compat.ts";
import { azureOpenAIResponsesProvider } from "../src/providers/azure-openai-responses.ts";
import type { AssistantMessage, Context } from "../src/types.ts";

interface FakeOpenAIClientOptions {
	apiKey: string;
	baseURL: string;
}

interface CapturedCompletionsPayload {
	model?: string;
	messages?: Array<{ role: string; content?: unknown; reasoning_content?: string }>;
	reasoning_effort?: string;
	thinking?: unknown;
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedCompletionsPayload | undefined,
	lastClientOptions: undefined as FakeOpenAIClientOptions | undefined,
	dispatchedTo: undefined as "chat.completions" | "responses" | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedCompletionsPayload) => {
					mockState.lastParams = params;
					mockState.dispatchedTo = "chat.completions";
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
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

		constructor(options: FakeOpenAIClientOptions) {
			mockState.lastClientOptions = options;
		}
	}

	class FakeAzureOpenAI {
		responses = {
			create: () => {
				mockState.dispatchedTo = "responses";
				throw new Error("responses reached");
			},
		};
	}

	return { default: FakeOpenAI, AzureOpenAI: FakeAzureOpenAI };
});

const azure = azureOpenAIResponsesProvider();

const originalBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalCacheRetention = process.env.PI_CACHE_RETENTION;

beforeEach(() => {
	mockState.lastParams = undefined;
	mockState.lastClientOptions = undefined;
	mockState.dispatchedTo = undefined;
	delete process.env.PI_CACHE_RETENTION;
	process.env.AZURE_OPENAI_BASE_URL = "https://my-resource.services.ai.azure.com";
});

afterEach(() => {
	if (originalBaseUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
	else process.env.AZURE_OPENAI_BASE_URL = originalBaseUrl;
	if (originalCacheRetention === undefined) delete process.env.PI_CACHE_RETENTION;
	else process.env.PI_CACHE_RETENTION = originalCacheRetention;
});

const context = normalizeContext({
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
});

function deepSeekModel() {
	return getModel("azure-openai-responses", "deepseek-v4-pro");
}

// Regression for #9645: Azure Foundry rejects DeepSeek's thinking field and every prompt cache parameter here.
describe("azure-openai-responses deepseek-v4-pro over Chat Completions", () => {
	it("turns thinking on with reasoning_effort instead of DeepSeek's thinking field", async () => {
		await azure.streamSimple(deepSeekModel(), context, { apiKey: "test-key", reasoning: "high" }).result();

		expect(mockState.lastParams?.reasoning_effort).toBe("high");
		expect(mockState.lastParams?.thinking).toBeUndefined();
	});

	it("clamps thinking levels the deployment does not accept", async () => {
		await azure.streamSimple(deepSeekModel(), context, { apiKey: "test-key", reasoning: "max" }).result();

		expect(mockState.lastParams?.reasoning_effort).toBe("high");
	});

	it("sends no reasoning_effort when no thinking level is requested", async () => {
		await azure.streamSimple(deepSeekModel(), context, { apiKey: "test-key" }).result();

		expect(mockState.lastParams?.reasoning_effort).toBeUndefined();
		expect(mockState.lastParams?.thinking).toBeUndefined();
	});

	it("omits prompt cache parameters when long retention comes from PI_CACHE_RETENTION", async () => {
		process.env.PI_CACHE_RETENTION = "long";

		await azure.stream(deepSeekModel(), context, { apiKey: "test-key", sessionId: "session-env" }).result();

		expect(mockState.lastParams?.prompt_cache_key).toBeUndefined();
		expect(mockState.lastParams?.prompt_cache_retention).toBeUndefined();
	});

	// The deployment discards a `developer` system message once reasoning_effort is set, without
	// billing it, so the system prompt has to go out under the system role.
	it("sends the system prompt under the system role", async () => {
		await azure.stream(deepSeekModel(), context, { apiKey: "test-key", reasoningEffort: "low" }).result();

		expect(mockState.lastParams?.messages?.[0]).toMatchObject({ role: "system", content: "sys" });
	});

	// The deployment honours system messages sent mid-conversation, so pi must not collapse them.
	it("keeps mid-conversation system messages in place", async () => {
		const resumed = normalizeContext({
			systemPrompt: "first",
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				{ role: "system", content: "second", timestamp: Date.now() },
				{ role: "user", content: "again", timestamp: Date.now() },
			],
		});

		await azure.stream(deepSeekModel(), resumed, { apiKey: "test-key" }).result();

		expect(mockState.lastParams?.messages?.map((message) => message.role)).toEqual([
			"system",
			"user",
			"system",
			"user",
		]);
	});

	it("omits prompt cache parameters even when long retention is requested", async () => {
		await azure
			.stream(deepSeekModel(), context, { apiKey: "test-key", cacheRetention: "long", sessionId: "session-1" })
			.result();

		expect(mockState.lastParams?.prompt_cache_key).toBeUndefined();
		expect(mockState.lastParams?.prompt_cache_retention).toBeUndefined();
	});

	it("replays reasoning_content on assistant turns so the cached prefix is unchanged", async () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "answer" },
			],
			provider: "azure-openai-responses",
			api: "openai-completions",
			model: "deepseek-v4-pro",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const resumed: Context = {
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "first", timestamp: Date.now() },
				assistant,
				{ role: "user", content: "second", timestamp: Date.now() },
			],
		};

		await azure.stream(deepSeekModel(), normalizeContext(resumed), { apiKey: "test-key" }).result();

		const assistantMessage = mockState.lastParams?.messages?.find((message) => message.role === "assistant");
		expect(assistantMessage?.reasoning_content).toBe("internal reasoning");
	});
});

describe("azure-openai-responses Chat Completions endpoint resolution", () => {
	it("normalizes the Azure endpoint the completions client is built with", async () => {
		await azure.stream(deepSeekModel(), context, { apiKey: "test-key" }).result();

		expect(mockState.lastClientOptions?.baseURL).toBe("https://my-resource.services.ai.azure.com/openai/v1");
	});

	it("surfaces an unconfigured endpoint as an error event rather than throwing out of stream()", async () => {
		delete process.env.AZURE_OPENAI_BASE_URL;

		const result = await azure.stream(deepSeekModel(), context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Azure OpenAI base URL is required");
	});

	// The id is persisted on the assistant message and read back by name, so it has to stay a catalog id.
	it("sends the model id as the request model", async () => {
		const result = await azure.stream(deepSeekModel(), context, { apiKey: "test-key" }).result();

		expect(mockState.lastParams?.model).toBe("deepseek-v4-pro");
		expect(result.model).toBe("deepseek-v4-pro");
	});
});

describe("azure-openai-responses api map", () => {
	it("still routes Responses models to the Responses api", async () => {
		await azure.stream(getModel("azure-openai-responses", "gpt-4o-mini"), context, { apiKey: "test-key" }).result();

		expect(mockState.dispatchedTo).toBe("responses");
	});

	it("routes openai-completions models to chat completions", async () => {
		await azure.stream(deepSeekModel(), context, { apiKey: "test-key" }).result();

		expect(mockState.dispatchedTo).toBe("chat.completions");
	});
});
