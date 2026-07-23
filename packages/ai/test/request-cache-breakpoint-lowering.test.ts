import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import {
	type AssistantMessage,
	type Context,
	type Model,
	markRequestCacheBreakpoint,
	REQUEST_CACHE_BREAKPOINT,
	type TextContent,
} from "../src/index.ts";

const STOP_AFTER_PAYLOAD = new Error("payload captured");

async function capturePayload(
	run: (onPayload: (payload: unknown) => never) => { result(): Promise<unknown> },
): Promise<{ payload: Record<string, unknown>; captures: number }> {
	let payload: Record<string, unknown> | undefined;
	let captures = 0;
	await run((nextPayload) => {
		captures += 1;
		payload = nextPayload as Record<string, unknown>;
		throw STOP_AFTER_PAYLOAD;
	}).result();
	if (!payload) throw new Error("Expected provider payload to be captured");
	return { payload, captures };
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function cacheControlledBlocks(payload: Record<string, unknown>): Array<Record<string, unknown>> {
	return blocksWithField(payload, "cache_control");
}

function explicitPromptCacheBreakpointBlocks(payload: Record<string, unknown>): Array<Record<string, unknown>> {
	return blocksWithField(payload, "prompt_cache_breakpoint");
}

function blocksWithField(payload: Record<string, unknown>, field: string): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		if (field in record) blocks.push(record);
		for (const child of Object.values(record)) visit(child);
	};
	visit(payload);
	return blocks;
}

function createCompletionsModel(supported: boolean): Model<"openai-completions"> {
	return {
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		compat: {
			cacheControlFormat: supported ? "openai-content-block" : undefined,
		},
	};
}

function createResponsesModel(supported: boolean): Model<"openai-responses"> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		compat: {
			cacheControlFormat: supported ? "openai-content-block" : undefined,
		},
	};
}

function createAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

describe("request cache breakpoint provider lowering", () => {
	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"enables explicit content breakpoints only for verified official OpenAI model %s",
		(modelId) => {
			expect(getModel("openai", modelId).compat?.cacheControlFormat).toBe("openai-content-block");
			expect(getModel("openai-codex", modelId).compat?.cacheControlFormat).toBeUndefined();
		},
	);

	it("lowers one marked image block for explicitly capable OpenAI Chat Completions models", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "prefix" },
						markRequestCacheBreakpoint({
							type: "image",
							data: "aW1hZ2U=",
							mimeType: "image/png",
						}),
						{ type: "text", text: "suffix" },
					],
					timestamp: 1,
				},
			],
		};

		const { payload, captures } = await capturePayload((onPayload) =>
			streamOpenAICompletions(createCompletionsModel(true), context, {
				apiKey: "test",
				sessionId: "completions-session",
				onPayload,
			}),
		);

		expect(captures).toBe(1);
		expect(payload.prompt_cache_key).toBe("completions-session");
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(payload.cache_control).toBeUndefined();
		expect(cacheControlledBlocks(payload)).toEqual([]);
		expect(explicitPromptCacheBreakpointBlocks(payload)).toEqual([
			expect.objectContaining({
				type: "image_url",
				prompt_cache_breakpoint: { mode: "explicit" },
			}),
		]);
	});

	it("lowers one marked text block for explicitly capable OpenAI Responses models", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						markRequestCacheBreakpoint({ type: "text", text: "stable prefix" }),
						{ type: "text", text: "current suffix" },
					],
					timestamp: 1,
				},
			],
		};

		const { payload, captures } = await capturePayload((onPayload) =>
			streamOpenAIResponses(createResponsesModel(true), context, {
				apiKey: "test",
				sessionId: "responses-session",
				onPayload,
			}),
		);

		expect(captures).toBe(1);
		expect(payload.prompt_cache_key).toBe("responses-session");
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(payload.cache_control).toBeUndefined();
		expect(cacheControlledBlocks(payload)).toEqual([]);
		expect(explicitPromptCacheBreakpointBlocks(payload)).toEqual([
			expect.objectContaining({
				type: "input_text",
				text: "stable prefix",
				prompt_cache_breakpoint: { mode: "explicit" },
			}),
		]);
	});

	it.each([
		["openai-completions", createCompletionsModel(false), streamOpenAICompletions],
		["openai-responses", createResponsesModel(false), streamOpenAIResponses],
	] as const)("strips markers for unsupported %s models without probing or replay", async (_api, model, streamApi) => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						markRequestCacheBreakpoint({ type: "text", text: "stable prefix" }),
						{
							type: "text",
							text: "lookalike",
							requestCacheBreakpoint: true,
						} as TextContent & { requestCacheBreakpoint: boolean },
					],
					timestamp: 1,
				},
			],
		};

		const { payload, captures } = await capturePayload((onPayload) =>
			streamApi(model as never, context, {
				apiKey: "test",
				sessionId: "unsupported-session",
				onPayload,
			}),
		);

		expect(captures).toBe(1);
		expect(cacheControlledBlocks(payload)).toEqual([]);
		expect(explicitPromptCacheBreakpointBlocks(payload)).toEqual([]);
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(JSON.stringify(payload)).not.toContain("requestCacheBreakpoint");
	});

	it.each([
		["openai-completions", createCompletionsModel(true), streamOpenAICompletions],
		["openai-responses", createResponsesModel(true), streamOpenAIResponses],
	] as const)("strips %s content markers when cache retention is disabled", async (_api, model, streamApi) => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [markRequestCacheBreakpoint({ type: "text", text: "stable prefix" })],
					timestamp: 1,
				},
			],
		};

		const { payload } = await capturePayload((onPayload) =>
			streamApi(model as never, context, {
				apiKey: "test",
				cacheRetention: "none",
				sessionId: "disabled-session",
				onPayload,
			}),
		);

		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(cacheControlledBlocks(payload)).toEqual([]);
		expect(explicitPromptCacheBreakpointBlocks(payload)).toEqual([]);
	});

	it("moves Anthropic's conversation breakpoint to the latest valid explicit historical marker", async () => {
		const model = createAnthropicModel();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						markRequestCacheBreakpoint({ type: "text", text: "historical owner" }),
						{ type: "text", text: "historical tail" },
					],
					timestamp: 1,
				},
				createAssistantMessage("ack"),
				{
					role: "user",
					content: [{ type: "text", text: "current unmarked owner" }],
					timestamp: 3,
				},
			],
		};

		const { payload } = await capturePayload((onPayload) =>
			streamAnthropic(model, context, { apiKey: "test", onPayload }),
		);

		expect(cacheControlledBlocks(payload)).toEqual([
			expect.objectContaining({
				type: "text",
				text: "historical owner",
				cache_control: { type: "ephemeral" },
			}),
		]);
	});

	it("does not shift an invalid explicit Anthropic marker to an unmarked block", async () => {
		const model = createAnthropicModel();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "",
							[REQUEST_CACHE_BREAKPOINT]: true,
						},
						{ type: "text", text: "unmarked tail" },
					],
					timestamp: 1,
				},
			],
		};

		const { payload } = await capturePayload((onPayload) =>
			streamAnthropic(model, context, { apiKey: "test", onPayload }),
		);

		expect(cacheControlledBlocks(payload)).toEqual([]);
	});

	it("strips explicit Anthropic markers when cache retention is disabled", async () => {
		const model = createAnthropicModel();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [markRequestCacheBreakpoint({ type: "text", text: "stable prefix" })],
					timestamp: 1,
				},
			],
		};

		const { payload } = await capturePayload((onPayload) =>
			streamAnthropic(model, context, {
				apiKey: "test",
				cacheRetention: "none",
				onPayload,
			}),
		);

		expect(cacheControlledBlocks(payload)).toEqual([]);
	});
});
