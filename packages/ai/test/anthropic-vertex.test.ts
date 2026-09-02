import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchFunction } from "../src/types.ts";

interface VertexConstructorConfig {
	projectId?: string;
	region?: string;
	baseURL?: string | null;
	fetch?: FetchFunction;
	defaultHeaders?: Record<string, string>;
	apiKey?: string;
	timeout?: number;
	maxRetries?: number;
}

interface VertexCreateCall {
	params: Record<string, unknown>;
	options?: Record<string, unknown>;
}

const vertexMock = vi.hoisted(() => ({
	constructorCalls: [] as VertexConstructorConfig[],
	createCalls: [] as VertexCreateCall[],
	constructorError: undefined as Error | undefined,
}));

function sseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeAnthropicResponse(): Response {
	const body = [
		sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_vertex_test",
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-sonnet-4-5@20250929",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		}),
		sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "ok" },
		}),
		sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
		sseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		}),
		sseEvent("message_stop", { type: "message_stop" }),
	].join("");

	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", "x-test-response": "ok" },
	});
}

vi.mock("@anthropic-ai/vertex-sdk", () => {
	class FakeAnthropicVertex {
		messages = {
			create: (params: Record<string, unknown>, options?: Record<string, unknown>) => {
				vertexMock.createCalls.push({ params, options });
				return {
					asResponse: async () => makeAnthropicResponse(),
				};
			},
		};

		constructor(config: VertexConstructorConfig) {
			if (vertexMock.constructorError) throw vertexMock.constructorError;
			vertexMock.constructorCalls.push(config);
		}
	}

	return { AnthropicVertex: FakeAnthropicVertex, default: FakeAnthropicVertex };
});

import { type AnthropicVertexOptions, stream, streamSimple } from "../src/api/anthropic-vertex.ts";
import { createModels } from "../src/models.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { anthropicVertexProvider } from "../src/providers/anthropic-vertex.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

const VERTEX_ENV_KEYS = [
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"CLOUD_ML_REGION",
	"GOOGLE_CLOUD_LOCATION",
	"ANTHROPIC_VERTEX_BASE_URL",
	"GOOGLE_APPLICATION_CREDENTIALS",
] as const;

const originalEnv = Object.fromEntries(VERTEX_ENV_KEYS.map((key) => [key, process.env[key]]));

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};
const toolContext: Context = {
	...context,
	tools: [
		{
			name: "lookup",
			description: "Look up a value",
			parameters: Type.Object({ value: Type.String() }),
		},
	],
};

function restoreEnv(): void {
	for (const key of VERTEX_ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function clearVertexEnv(): void {
	for (const key of VERTEX_ENV_KEYS) delete process.env[key];
}

function vertexModel(id = "claude-sonnet-4-5@20250929"): Model<"anthropic-vertex"> {
	const getVertexModel = getBuiltinModel as (
		provider: "anthropic-vertex",
		modelId: string,
	) => Model<"anthropic-vertex">;
	return getVertexModel("anthropic-vertex", id);
}

async function run(
	model: Model<"anthropic-vertex">,
	options?: AnthropicVertexOptions,
	requestContext: Context = context,
): Promise<AssistantMessage> {
	const result = await stream(model, requestContext, options).result();
	expect(result.stopReason, result.errorMessage).not.toBe("error");
	return result;
}

beforeEach(() => {
	vertexMock.constructorCalls.length = 0;
	vertexMock.createCalls.length = 0;
	vertexMock.constructorError = undefined;
	clearVertexEnv();
});

afterEach(() => {
	restoreEnv();
});

describe("anthropic-vertex adapter", () => {
	it("constructs one request-scoped client and leaves timeout and retry ownership on the request", async () => {
		const controller = new AbortController();
		await run(vertexModel(), {
			project: "option-project",
			location: "us-east5",
			timeoutMs: 15_000,
			maxRetries: 3,
			signal: controller.signal,
		});

		expect(vertexMock.constructorCalls).toEqual([
			expect.objectContaining({
				projectId: "option-project",
				region: "us-east5",
			}),
		]);
		expect(vertexMock.constructorCalls[0]).not.toHaveProperty("apiKey");
		expect(vertexMock.constructorCalls[0]).not.toHaveProperty("timeout");
		expect(vertexMock.constructorCalls[0]).not.toHaveProperty("maxRetries");
		expect(vertexMock.createCalls[0]?.options).toMatchObject({
			maxRetries: 0,
			timeout: 15_000,
			signal: controller.signal,
		});
	});

	it("passes a custom fetch through simple options to the request-scoped client", async () => {
		const fetch = vi.fn<FetchFunction>();

		const result = await streamSimple(vertexModel(), context, { fetch }).result();

		expect(result.stopReason, result.errorMessage).not.toBe("error");
		expect(vertexMock.constructorCalls[0]?.fetch).toBe(fetch);
	});

	it("resolves explicit, scoped, and ambient project/location values in order", async () => {
		process.env.ANTHROPIC_VERTEX_PROJECT_ID = "ambient-anthropic-project";
		process.env.GOOGLE_CLOUD_PROJECT = "ambient-google-project";
		process.env.CLOUD_ML_REGION = "ambient-region";

		await run(vertexModel(), {
			project: "option-project",
			location: "option-region",
			env: {
				ANTHROPIC_VERTEX_PROJECT_ID: "scoped-anthropic-project",
				GOOGLE_CLOUD_PROJECT: "scoped-google-project",
				CLOUD_ML_REGION: "scoped-region",
			},
		});
		expect(vertexMock.constructorCalls[0]).toMatchObject({
			projectId: "option-project",
			region: "option-region",
		});

		vertexMock.constructorCalls.length = 0;
		await run(vertexModel(), {
			env: {
				ANTHROPIC_VERTEX_PROJECT_ID: "scoped-anthropic-project",
				GOOGLE_CLOUD_PROJECT: "scoped-google-project",
				CLOUD_ML_REGION: "scoped-region",
			},
		});
		expect(vertexMock.constructorCalls[0]).toMatchObject({
			projectId: "scoped-anthropic-project",
			region: "scoped-region",
		});

		vertexMock.constructorCalls.length = 0;
		await run(vertexModel());
		expect(vertexMock.constructorCalls[0]).toMatchObject({
			projectId: "ambient-anthropic-project",
			region: "ambient-region",
		});
	});

	it("defaults location to global and leaves project unset for SDK credential inference", async () => {
		await run(vertexModel());

		expect(vertexMock.constructorCalls[0]).toMatchObject({ region: "global", baseURL: null });
		expect(vertexMock.constructorCalls[0]).not.toHaveProperty("projectId");
	});

	it("ignores generated endpoint placeholders and resolves concrete base URLs in order", async () => {
		process.env.ANTHROPIC_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";

		await run(vertexModel());
		expect(vertexMock.constructorCalls[0]?.baseURL).toBeNull();

		vertexMock.constructorCalls.length = 0;
		process.env.ANTHROPIC_VERTEX_BASE_URL = "https://ambient.example.test/v1";

		await run(vertexModel(), {
			env: { ANTHROPIC_VERTEX_BASE_URL: "https://scoped.example.test/v1" },
		});
		expect(vertexMock.constructorCalls[0]?.baseURL).toBe("https://scoped.example.test/v1");

		vertexMock.constructorCalls.length = 0;
		await run(
			{ ...vertexModel(), baseUrl: "https://model.example.test/custom/v1" },
			{ env: { ANTHROPIC_VERTEX_BASE_URL: "https://scoped.example.test/v1" } },
		);
		expect(vertexMock.constructorCalls[0]?.baseURL).toBe("https://model.example.test/custom/v1");
	});

	it("allows the ambient credential path but rejects a different scoped path without exposing either path", async () => {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = "/ambient/private/adc.json";

		await run(vertexModel(), {
			env: { GOOGLE_APPLICATION_CREDENTIALS: "/ambient/private/adc.json" },
		});
		expect(vertexMock.constructorCalls).toHaveLength(1);

		vertexMock.constructorCalls.length = 0;
		const result = await stream(vertexModel(), context, {
			env: { GOOGLE_APPLICATION_CREDENTIALS: "/scoped/private/adc.json" },
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("process-scoped Google Application Default Credentials");
		expect(result.errorMessage).not.toContain("/ambient/private");
		expect(result.errorMessage).not.toContain("/scoped/private");
		expect(vertexMock.constructorCalls).toEqual([]);
	});

	it("keeps concurrent scoped requests isolated and does not mutate process.env", async () => {
		const before = Object.fromEntries(VERTEX_ENV_KEYS.map((key) => [key, process.env[key]]));

		await Promise.all([
			run(vertexModel(), {
				env: {
					ANTHROPIC_VERTEX_PROJECT_ID: "project-a",
					CLOUD_ML_REGION: "region-a",
				},
			}),
			run(vertexModel(), {
				env: {
					ANTHROPIC_VERTEX_PROJECT_ID: "project-b",
					CLOUD_ML_REGION: "region-b",
				},
			}),
		]);

		expect(vertexMock.constructorCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ projectId: "project-a", region: "region-a" }),
				expect.objectContaining({ projectId: "project-b", region: "region-b" }),
			]),
		);
		expect(Object.fromEntries(VERTEX_ENV_KEYS.map((key) => [key, process.env[key]]))).toEqual(before);
	});

	it("merges automatic, model, and caller headers case-insensitively with null suppression", async () => {
		await run(
			{
				...vertexModel(),
				headers: {
					"X-Model-Header": "model",
					"Anthropic-Beta": "model-beta",
				},
			},
			{
				headers: {
					"x-model-header": null,
					"ANTHROPIC-BETA": "caller-beta",
					Authorization: "Bearer explicit-override",
				},
			},
		);

		expect(vertexMock.constructorCalls[0]?.defaultHeaders).toEqual({
			"ANTHROPIC-BETA": "caller-beta",
			Authorization: "Bearer explicit-override",
		});
		expect(vertexMock.createCalls[0]?.options).toMatchObject({
			headers: { Authorization: "Bearer explicit-override" },
		});
	});

	it("adds only the established interleaved-thinking beta to nonadaptive models", async () => {
		// Google Cloud accepts this header on every model and ignores it where
		// interleaved thinking is unsupported, so nonadaptive models all receive it.
		for (const modelId of ["claude-sonnet-4-5@20250929", "claude-opus-4-5@20251101", "claude-haiku-4-5@20251001"]) {
			vertexMock.constructorCalls.length = 0;
			await run(vertexModel(modelId));
			expect(vertexMock.constructorCalls[0]?.defaultHeaders, modelId).toEqual({
				"anthropic-beta": "interleaved-thinking-2025-05-14",
			});
		}

		// Adaptive-thinking models interleave without the beta.
		vertexMock.constructorCalls.length = 0;
		await run(vertexModel("claude-opus-4-8"));
		expect(vertexMock.constructorCalls[0]?.defaultHeaders).toEqual({});

		vertexMock.constructorCalls.length = 0;
		await run(vertexModel(), { interleavedThinking: false });
		expect(vertexMock.constructorCalls[0]?.defaultHeaders).toEqual({});
	});

	it("delegates payload, response, and request shaping to the shared Anthropic implementation", async () => {
		let payloadModelApi: string | undefined;
		let responseStatus: number | undefined;

		const result = await run(vertexModel(), {
			metadata: { user_id: "vertex-user" },
			onPayload: (payload, model) => {
				payloadModelApi = model.api;
				return payload;
			},
			onResponse: (response) => {
				responseStatus = response.status;
			},
		});

		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(payloadModelApi).toBe("anthropic-vertex");
		expect(responseStatus).toBe(200);
		expect(vertexMock.createCalls[0]?.params).toMatchObject({
			metadata: { user_id: "vertex-user" },
			model: vertexModel().id,
			stream: true,
		});
	});

	it("preserves shared Anthropic tool conversion and eager input streaming", async () => {
		await run(vertexModel(), undefined, toolContext);

		expect(vertexMock.createCalls[0]?.params).toMatchObject({
			tools: [
				{
					name: "lookup",
					description: "Look up a value",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
					eager_input_streaming: true,
				},
			],
		});
	});

	it("maps budget and adaptive simple reasoning without forwarding API keys", async () => {
		await streamSimple(vertexModel(), context, {
			apiKey: "must-not-reach-vertex",
			maxTokens: 4096,
			reasoning: "high",
		}).result();
		expect(vertexMock.createCalls[0]?.params).toMatchObject({
			max_tokens: 20_480,
			thinking: { type: "enabled", budget_tokens: 16_384 },
		});
		expect(vertexMock.constructorCalls[0]).not.toHaveProperty("apiKey");

		for (const modelId of ["claude-sonnet-5", "claude-opus-5"]) {
			vertexMock.createCalls.length = 0;
			await streamSimple(vertexModel(modelId), context, {
				reasoning: "xhigh",
				temperature: 0.7,
			}).result();
			expect(vertexMock.createCalls[0]?.params).toMatchObject({
				thinking: { type: "adaptive", display: "summarized" },
				output_config: { effort: "xhigh" },
			});
			expect(vertexMock.createCalls[0]?.params).not.toHaveProperty("temperature");
		}
	});

	it("encodes constructor/setup failures in the returned stream", async () => {
		vertexMock.constructorError = new Error("synthetic ADC setup failure");

		const result = await stream(vertexModel(), context).result();

		expect(result).toMatchObject({
			api: "anthropic-vertex",
			provider: "anthropic-vertex",
			stopReason: "error",
			errorMessage: "synthetic ADC setup failure",
		});
	});
});

describe("anthropic-vertex provider discovery", () => {
	it("uses conservative ADC discovery without a login flow or location requirement", async () => {
		const auth = anthropicVertexProvider().auth.apiKey;
		const signal = new AbortController().signal;
		expect(auth?.login).toBeUndefined();

		const projectOnly = await auth?.check?.({
			ctx: {
				env: async (name) => (name === "ANTHROPIC_VERTEX_PROJECT_ID" ? "project-id" : undefined),
				fileExists: async () => false,
			},
			signal,
		});
		expect(projectOnly).toEqual({
			type: "api_key",
			source: "Google Cloud environment",
		});

		const defaultAdcOnly = await auth?.check?.({
			ctx: {
				env: async () => undefined,
				fileExists: async (path) => path === "~/.config/gcloud/application_default_credentials.json",
			},
			signal,
		});
		expect(defaultAdcOnly).toEqual({
			type: "api_key",
			source: "Google Application Default Credentials",
		});

		const storedProject = await auth?.check?.({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			credential: {
				type: "api_key",
				env: {
					ANTHROPIC_VERTEX_PROJECT_ID: "stored-project",
					CLOUD_ML_REGION: "stored-region",
				},
			},
			signal,
		});
		expect(storedProject).toEqual({
			type: "api_key",
			source: "stored credential",
		});

		const unavailable = await auth?.check?.({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			signal,
		});
		expect(unavailable).toBeUndefined();
	});

	it("defers the complete ADC chain to the SDK at request time", async () => {
		const auth = anthropicVertexProvider().auth.apiKey;
		const resolution = await auth?.resolve({
			ctx: {
				env: async () => undefined,
				fileExists: async () => false,
			},
			signal: new AbortController().signal,
		});

		expect(resolution).toEqual({
			auth: {},
			source: "Google Application Default Credentials",
		});
	});

	it("honors cancellation before ADC discovery and request-time resolution", async () => {
		const auth = anthropicVertexProvider().auth.apiKey;
		const env = vi.fn(async () => undefined);
		const fileExists = vi.fn(async () => false);
		const signal = AbortSignal.abort();

		await expect(auth?.check?.({ ctx: { env, fileExists }, signal })).rejects.toMatchObject({ name: "AbortError" });
		await expect(auth?.resolve({ ctx: { env, fileExists }, signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(env).not.toHaveBeenCalled();
		expect(fileExists).not.toHaveBeenCalled();
	});

	it("lets Models dispatch without locally discoverable ADC signals", async () => {
		const models = createModels({
			authContext: {
				env: async () => undefined,
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicVertexProvider());
		const model = models.getModel("anthropic-vertex", "claude-sonnet-5");
		if (!model) throw new Error("Expected Anthropic Vertex model");

		const result = await models.complete(model, context);

		expect(result.stopReason, result.errorMessage).not.toBe("error");
		expect(vertexMock.constructorCalls).toHaveLength(1);
	});
});
