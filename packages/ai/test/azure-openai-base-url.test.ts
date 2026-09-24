import { arch, platform, release } from "node:os";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Api, Context, Model } from "../src/types.ts";

interface CapturedAzureClientOptions {
	apiKey: string;
	apiVersion: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
	baseURL: string;
}

interface CapturedAzureResponsesPayload {
	prompt_cache_key?: string;
	store?: boolean;
	tools?: Array<{ strict?: boolean }>;
}

const azureMock = vi.hoisted(() => ({
	constructorCalls: [] as CapturedAzureClientOptions[],
	lastParams: undefined as CapturedAzureResponsesPayload | undefined,
	streamEvents: undefined as ResponseStreamEvent[] | undefined,
}));

vi.mock("openai", () => {
	class AzureOpenAI {
		responses = {
			create: (params: CapturedAzureResponsesPayload) => {
				azureMock.lastParams = params;
				const events = azureMock.streamEvents;
				if (!events) throw new Error("mock create");
				return {
					withResponse: async () => ({
						data: (async function* () {
							for (const event of events) yield event;
						})(),
						response: { status: 200, headers: new Headers() },
					}),
				};
			},
		};

		constructor(config: CapturedAzureClientOptions) {
			azureMock.constructorCalls.push(config);
		}
	}

	return { AzureOpenAI };
});

const PI_USER_AGENT = `pi (${platform()} ${release()}; ${arch()})`;

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const originalAzureOpenAIBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalAzureOpenAIResourceName = process.env.AZURE_OPENAI_RESOURCE_NAME;
const originalAzureOpenAIApiVersion = process.env.AZURE_OPENAI_API_VERSION;
const originalAzureOpenAIApiKey = process.env.AZURE_OPENAI_API_KEY;

beforeEach(() => {
	azureMock.constructorCalls.length = 0;
	azureMock.lastParams = undefined;
	azureMock.streamEvents = undefined;
	delete process.env.AZURE_OPENAI_BASE_URL;
	delete process.env.AZURE_OPENAI_RESOURCE_NAME;
	delete process.env.AZURE_OPENAI_API_VERSION;
	delete process.env.AZURE_OPENAI_API_KEY;
});

afterEach(() => {
	if (originalAzureOpenAIBaseUrl === undefined) {
		delete process.env.AZURE_OPENAI_BASE_URL;
	} else {
		process.env.AZURE_OPENAI_BASE_URL = originalAzureOpenAIBaseUrl;
	}

	if (originalAzureOpenAIResourceName === undefined) {
		delete process.env.AZURE_OPENAI_RESOURCE_NAME;
	} else {
		process.env.AZURE_OPENAI_RESOURCE_NAME = originalAzureOpenAIResourceName;
	}

	if (originalAzureOpenAIApiVersion === undefined) {
		delete process.env.AZURE_OPENAI_API_VERSION;
	} else {
		process.env.AZURE_OPENAI_API_VERSION = originalAzureOpenAIApiVersion;
	}

	if (originalAzureOpenAIApiKey === undefined) {
		delete process.env.AZURE_OPENAI_API_KEY;
	} else {
		process.env.AZURE_OPENAI_API_KEY = originalAzureOpenAIApiKey;
	}
});

async function captureClientBaseUrl(baseUrl: string): Promise<string> {
	process.env.AZURE_OPENAI_BASE_URL = baseUrl;
	const model = getModel("azure-openai-responses", "gpt-4o-mini");
	await streamAzureOpenAIResponses(model, normalizeContext(context), { apiKey: "test-api-key" }).result();
	expect(azureMock.constructorCalls).toHaveLength(1);
	return azureMock.constructorCalls[0].baseURL;
}

async function captureClientHeaders(headers?: Record<string, string>): Promise<Record<string, string>> {
	const model = getModel("azure-openai-responses", "gpt-4o-mini");
	await streamAzureOpenAIResponses(model, normalizeContext(context), {
		apiKey: "test-api-key",
		azureBaseUrl: "https://my-resource.openai.azure.com",
		headers,
	}).result();
	expect(azureMock.constructorCalls).toHaveLength(1);
	return azureMock.constructorCalls[0].defaultHeaders ?? {};
}

describe("azure-openai-responses base URL normalization", () => {
	it("normalizes Cognitive Services root endpoints to /openai/v1", async () => {
		const baseURL = await captureClientBaseUrl("https://marc-quicktests-resource.cognitiveservices.azure.com");
		expect(baseURL).toBe("https://marc-quicktests-resource.cognitiveservices.azure.com/openai/v1");
	});

	it("normalizes Microsoft Foundry root endpoints to /openai/v1", async () => {
		const baseURL = await captureClientBaseUrl("https://marc-quicktests-resource.ai.azure.com");
		expect(baseURL).toBe("https://marc-quicktests-resource.ai.azure.com/openai/v1");
	});

	it("normalizes Azure OpenAI root endpoints to /openai/v1", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.openai.azure.com");
		expect(baseURL).toBe("https://my-resource.openai.azure.com/openai/v1");
	});

	it("normalizes /openai to /openai/v1", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.cognitiveservices.azure.com/openai");
		expect(baseURL).toBe("https://my-resource.cognitiveservices.azure.com/openai/v1");
	});

	it("preserves /openai/v1 endpoints", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.cognitiveservices.azure.com/openai/v1");
		expect(baseURL).toBe("https://my-resource.cognitiveservices.azure.com/openai/v1");
	});

	it("normalizes /openai/v1/responses to /openai/v1", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.services.ai.azure.com/openai/v1/responses");
		expect(baseURL).toBe("https://my-resource.services.ai.azure.com/openai/v1");
	});

	it("preserves explicit non-Azure proxy paths", async () => {
		const baseURL = await captureClientBaseUrl("https://my-proxy.example.com/v1");
		expect(baseURL).toBe("https://my-proxy.example.com/v1");
	});

	it("strips query params when normalizing Azure host URLs", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.openai.azure.com/openai?api-version=2024-12-01");
		expect(baseURL).toBe("https://my-resource.openai.azure.com/openai/v1");
	});

	it("preserves query params on non-Azure proxy URLs", async () => {
		const baseURL = await captureClientBaseUrl("https://my-proxy.example.com/v1?custom=true");
		expect(baseURL).toBe("https://my-proxy.example.com/v1?custom=true");
	});

	it("throws on invalid URLs", async () => {
		process.env.AZURE_OPENAI_BASE_URL = "not-a-url";
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		const result = await streamAzureOpenAIResponses(model, normalizeContext(context), {
			apiKey: "test-api-key",
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid Azure OpenAI base URL");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		await streamAzureOpenAIResponses(model, normalizeContext(context), {
			apiKey: "test-api-key",
			azureBaseUrl: "https://my-resource.openai.azure.com",
			sessionId: "x".repeat(67),
		}).result();

		expect(azureMock.lastParams?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("disables server-side response storage", async () => {
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		await streamAzureOpenAIResponses(model, normalizeContext(context), {
			apiKey: "test-api-key",
			azureBaseUrl: "https://my-resource.openai.azure.com",
		}).result();

		expect(azureMock.lastParams?.store).toBe(false);
	});

	it("honors supportsStrictMode: false", async () => {
		const baseModel = getModel("azure-openai-responses", "gpt-4o-mini");
		const model: Model<"azure-openai-responses"> = {
			...baseModel,
			compat: { ...baseModel.compat, supportsStrictMode: false },
		};

		await streamAzureOpenAIResponses(
			model,
			normalizeContext({
				...context,
				tools: [
					{
						name: "preferred",
						description: "Preferred constrained tool",
						parameters: Type.Object({ value: Type.String() }),
						constrainedSampling: { type: "json_schema", strict: "prefer" },
					},
				],
			}),
			{ apiKey: "test-api-key", azureBaseUrl: "https://my-resource.openai.azure.com" },
		).result();

		expect(azureMock.lastParams?.tools?.[0]).not.toHaveProperty("strict");
	});

	it("builds correct default URL from AZURE_OPENAI_RESOURCE_NAME", async () => {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		await streamAzureOpenAIResponses(model, normalizeContext(context), { apiKey: "test-api-key" }).result();
		expect(azureMock.constructorCalls).toHaveLength(1);
		expect(azureMock.constructorCalls[0].baseURL).toBe("https://my-resource.openai.azure.com/openai/v1");
	});
});

describe("azure-openai-responses provider stream events", () => {
	it("forwards parsed events in order before normalizing the response", async () => {
		azureMock.streamEvents = [
			{ type: "response.created", sequence_number: 0, response: { id: "resp_azure" } } as ResponseStreamEvent,
			{
				type: "response.completed",
				sequence_number: 1,
				response: { id: "resp_azure", status: "completed" },
			} as ResponseStreamEvent,
		];
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		const received: unknown[] = [];
		const eventModels: Model<Api>[] = [];
		const result = await streamAzureOpenAIResponses(model, normalizeContext(context), {
			apiKey: "test-api-key",
			azureBaseUrl: "https://my-resource.openai.azure.com",
			onProviderStreamEvent: async (event, eventModel) => {
				await Promise.resolve();
				received.push(event);
				eventModels.push(eventModel);
			},
		}).result();

		expect(received).toEqual(azureMock.streamEvents);
		expect(received[0]).toBe(azureMock.streamEvents[0]);
		expect(received[1]).toBe(azureMock.streamEvents[1]);
		expect(eventModels).toEqual([model, model]);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("resp_azure");
	});
});

describe("azure-openai-responses user agent", () => {
	it("uses pi's User-Agent by default", async () => {
		expect((await captureClientHeaders())["User-Agent"]).toBe(PI_USER_AGENT);
	});

	it("lets explicit headers override the default User-Agent", async () => {
		expect((await captureClientHeaders({ "User-Agent": "custom-agent" }))["User-Agent"]).toBe("custom-agent");
	});
});
