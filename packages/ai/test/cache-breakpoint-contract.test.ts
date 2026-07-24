import { afterEach, describe, expect, it } from "vitest";
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
	selectRequestCacheBreakpoint,
	type TextContent,
} from "../src/index.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

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
});
