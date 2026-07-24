import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { complete as completeCompat, registerApiProvider, resetApiProviders } from "../src/compat.ts";
import {
	type Context,
	CUSTOM_API_REQUEST_CACHE_BREAKPOINT_BEHAVIOR,
	createModels,
	createProvider,
	hasRequestCacheBreakpoint,
	type KnownApi,
	type Model,
	markRequestCacheBreakpoint,
	REQUEST_CACHE_BREAKPOINT,
	REQUEST_CACHE_BREAKPOINT_BEHAVIOR_BY_API,
	type StreamOptions,
	selectRequestCacheBreakpoint,
	type TextContent,
} from "../src/index.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const STOP_AFTER_PAYLOAD = new Error("payload captured");

const KNOWN_APIS = [
	"openai-completions",
	"mistral-conversations",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"pi-messages",
] as const satisfies readonly KnownApi[];

const customModel: Model<"openai-responses"> = {
	id: "custom-cache-contract",
	name: "Custom cache contract",
	api: "openai-responses",
	provider: "custom-cache-provider",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

function markedContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: [markRequestCacheBreakpoint({ type: "text", text: "stable prefix" })],
				timestamp: 1,
			},
		],
	};
}

function contextHasRequestCacheBreakpoint(context: Context): boolean {
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (Reflect.ownKeys(block).includes(REQUEST_CACHE_BREAKPOINT)) return true;
		}
	}
	return false;
}

function payloadHasRequestCacheBreakpoint(value: unknown, seen = new WeakSet<object>()): boolean {
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Reflect.ownKeys(value).includes(REQUEST_CACHE_BREAKPOINT)) return true;
	for (const key of Reflect.ownKeys(value)) {
		if (payloadHasRequestCacheBreakpoint((value as Record<PropertyKey, unknown>)[key], seen)) return true;
	}
	return false;
}

function payloadHasField(value: unknown, field: string, seen = new WeakSet<object>()): boolean {
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Object.hasOwn(value, field)) return true;
	for (const key of Reflect.ownKeys(value)) {
		if (payloadHasField((value as Record<PropertyKey, unknown>)[key], field, seen)) return true;
	}
	return false;
}

function createSerializationModel<TApi extends KnownApi>(api: TApi, overrides: Partial<Model<TApi>> = {}): Model<TApi> {
	return {
		id: "serialization-contract",
		name: "Serialization contract",
		api,
		provider: "serialization-contract",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	} as Model<TApi>;
}

function createCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct_serialization_contract",
			},
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

async function captureAdapterPayload(
	run: (onPayload: NonNullable<StreamOptions["onPayload"]>) => AssistantMessageEventStream,
): Promise<{ payload: unknown; captures: number }> {
	let payload: unknown;
	let captures = 0;
	await run((_nextPayload) => {
		captures += 1;
		payload = _nextPayload;
		throw STOP_AFTER_PAYLOAD;
	}).result();
	if (payload === undefined) throw new Error("Expected provider payload to be captured");
	return { payload, captures };
}

function completedStream(model: Model<"openai-responses">): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

describe("request cache breakpoint contract", () => {
	afterEach(() => {
		resetApiProviders();
	});

	it("keeps the KnownApi lowering policy exhaustive and fail-closed", () => {
		expect(Object.keys(REQUEST_CACHE_BREAKPOINT_BEHAVIOR_BY_API)).toEqual(KNOWN_APIS);
		expect(REQUEST_CACHE_BREAKPOINT_BEHAVIOR_BY_API).toEqual({
			"openai-completions": "capability-gated",
			"mistral-conversations": "strip",
			"openai-responses": "capability-gated",
			"azure-openai-responses": "strip",
			"openai-codex-responses": "strip",
			"anthropic-messages": "lower",
			"bedrock-converse-stream": "strip",
			"google-generative-ai": "strip",
			"google-vertex": "strip",
			"pi-messages": "strip",
		});
		expect(CUSTOM_API_REQUEST_CACHE_BREAKPOINT_BEHAVIOR).toBe("strip");
	});

	it("uses a symbol marker that cannot be forged through model-visible JSON", () => {
		const original: TextContent = { type: "text", text: "stable prefix" };
		const marked = markRequestCacheBreakpoint(original);

		expect(marked).not.toBe(original);
		expect(marked[REQUEST_CACHE_BREAKPOINT]).toBe(true);
		expect(hasRequestCacheBreakpoint(marked)).toBe(true);
		expect(JSON.stringify(marked)).toBe('{"type":"text","text":"stable prefix"}');

		const roundTripped = JSON.parse(JSON.stringify(marked)) as TextContent;
		expect(hasRequestCacheBreakpoint(roundTripped)).toBe(false);
		expect(
			hasRequestCacheBreakpoint({
				type: "text",
				text: "stable prefix",
				requestCacheBreakpoint: true,
			}),
		).toBe(false);
	});

	it("accepts cacheable text and image blocks and rejects empty blocks before wire conversion", () => {
		expect(
			hasRequestCacheBreakpoint(
				markRequestCacheBreakpoint({
					type: "image",
					data: "aW1hZ2U=",
					mimeType: "image/png",
				}),
			),
		).toBe(true);

		expect(() => markRequestCacheBreakpoint({ type: "text", text: "" })).toThrow(/cacheable/i);
		expect(() =>
			markRequestCacheBreakpoint({
				type: "image",
				data: "",
				mimeType: "image/png",
			}),
		).toThrow(/cacheable/i);
	});

	it("selects structural coordinates and lets a later malformed marker invalidate an earlier valid one", () => {
		const valid = markRequestCacheBreakpoint({ type: "text", text: "valid" });
		const malformed = {
			type: "text",
			text: "malformed",
			[REQUEST_CACHE_BREAKPOINT]: "true",
		} as unknown as TextContent;
		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: "leading" }, valid],
				timestamp: 1,
			},
		];

		expect(selectRequestCacheBreakpoint(messages)).toEqual({
			requested: true,
			messageIndex: 0,
			contentIndex: 1,
		});
		expect(selectRequestCacheBreakpoint([...messages, { role: "user", content: [malformed], timestamp: 2 }])).toEqual(
			{ requested: true },
		);
		expect(hasRequestCacheBreakpoint(malformed)).toBe(false);
	});

	it("strips markers before Models dispatches to a custom provider reusing a KnownApi", async () => {
		let receivedContext: Context | undefined;
		const streams = {
			stream: (model: Model<"openai-responses">, context: Context) => {
				receivedContext = context;
				return completedStream(model);
			},
			streamSimple: (model: Model<"openai-responses">, context: Context) => {
				receivedContext = context;
				return completedStream(model);
			},
		};
		const provider = createProvider({
			id: customModel.provider,
			auth: {
				apiKey: {
					name: "Test",
					resolve: async () => ({ auth: { apiKey: "test" } }),
				},
			},
			models: [customModel],
			api: streams,
		});
		const models = createModels();
		models.setProvider(provider);
		const context = markedContext();

		await models.complete(customModel, context, { apiKey: "test" });

		expect(receivedContext).toBeDefined();
		expect(contextHasRequestCacheBreakpoint(receivedContext!)).toBe(false);
		expect(contextHasRequestCacheBreakpoint(context)).toBe(true);
	});

	it("strips markers before compat dispatches to a registered override of a KnownApi", async () => {
		let receivedContext: Context | undefined;
		registerApiProvider({
			api: "openai-responses",
			stream: (model, context) => {
				receivedContext = context;
				return completedStream(model);
			},
			streamSimple: (model, context) => {
				receivedContext = context;
				return completedStream(model);
			},
		});

		const context = markedContext();
		await completeCompat(customModel, context, { apiKey: "test" });

		expect(receivedContext).toBeDefined();
		expect(contextHasRequestCacheBreakpoint(receivedContext!)).toBe(false);
		expect(contextHasRequestCacheBreakpoint(context)).toBe(true);
	});

	it("consumes or strips the marker through every KnownApi real serialization path", async () => {
		const context = markedContext();
		const cases: Array<{
			api: KnownApi;
			expectedLoweredField?: "prompt_cache_breakpoint" | "cache_control";
			run: (onPayload: NonNullable<StreamOptions["onPayload"]>) => AssistantMessageEventStream;
		}> = [
			{
				api: "openai-completions",
				expectedLoweredField: "prompt_cache_breakpoint",
				run: (onPayload) =>
					streamOpenAICompletions(
						createSerializationModel("openai-completions", {
							provider: "openai",
							baseUrl: "https://api.openai.com/v1",
							compat: { cacheControlFormat: "openai-content-block" },
						}),
						context,
						{ apiKey: "test", sessionId: "serialization-session", onPayload },
					),
			},
			{
				api: "mistral-conversations",
				run: (onPayload) =>
					streamMistral(createSerializationModel("mistral-conversations"), context, {
						apiKey: "test",
						onPayload,
					}),
			},
			{
				api: "openai-responses",
				expectedLoweredField: "prompt_cache_breakpoint",
				run: (onPayload) =>
					streamOpenAIResponses(
						createSerializationModel("openai-responses", {
							provider: "openai",
							baseUrl: "https://api.openai.com/v1",
							compat: { cacheControlFormat: "openai-content-block" },
						}),
						context,
						{ apiKey: "test", sessionId: "serialization-session", onPayload },
					),
			},
			{
				api: "azure-openai-responses",
				run: (onPayload) =>
					streamAzureOpenAIResponses(
						createSerializationModel("azure-openai-responses", {
							baseUrl: "https://serialization.openai.azure.com/openai/v1",
						}),
						context,
						{ apiKey: "test", onPayload },
					),
			},
			{
				api: "openai-codex-responses",
				run: (onPayload) =>
					streamOpenAICodexResponses(
						createSerializationModel("openai-codex-responses", {
							provider: "openai-codex",
							baseUrl: "https://chatgpt.com/backend-api",
						}),
						context,
						{ apiKey: createCodexToken(), transport: "sse", onPayload },
					),
			},
			{
				api: "anthropic-messages",
				expectedLoweredField: "cache_control",
				run: (onPayload) =>
					streamAnthropic(createSerializationModel("anthropic-messages"), context, {
						apiKey: "test",
						onPayload,
					}),
			},
			{
				api: "bedrock-converse-stream",
				run: (onPayload) =>
					streamBedrock(createSerializationModel("bedrock-converse-stream"), context, {
						env: { AWS_BEDROCK_SKIP_AUTH: "1" },
						onPayload,
					}),
			},
			{
				api: "google-generative-ai",
				run: (onPayload) =>
					streamGoogleGenerativeAI(createSerializationModel("google-generative-ai"), context, {
						apiKey: "test",
						onPayload,
					}),
			},
			{
				api: "google-vertex",
				run: (onPayload) =>
					streamGoogleVertex(createSerializationModel("google-vertex"), context, {
						apiKey: "test",
						onPayload,
					}),
			},
			{
				api: "pi-messages",
				run: (onPayload) =>
					streamPiMessages(createSerializationModel("pi-messages"), context, {
						apiKey: "test",
						onPayload,
					}),
			},
		];

		expect(cases.map(({ api }) => api)).toEqual(KNOWN_APIS);
		for (const testCase of cases) {
			const { payload, captures } = await captureAdapterPayload(testCase.run);
			expect(captures, testCase.api).toBe(1);
			expect(payloadHasRequestCacheBreakpoint(payload), testCase.api).toBe(false);
			expect(payloadHasField(payload, "prompt_cache_breakpoint"), testCase.api).toBe(
				testCase.expectedLoweredField === "prompt_cache_breakpoint",
			);
			expect(payloadHasField(payload, "cache_control"), testCase.api).toBe(
				testCase.expectedLoweredField === "cache_control",
			);
		}
		expect(contextHasRequestCacheBreakpoint(context)).toBe(true);
	});
});
