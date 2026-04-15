import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertMessages } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
};

function buildModel(): Model<"openai-completions"> {
	const baseModel = getModel("openai", "gpt-4o-mini");
	return {
		...baseModel,
		id: "gemini-3-pro-preview",
		provider: "google",
		api: "openai-completions",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
	};
}

function buildAssistantToolCall(thoughtSignature: string | undefined, now: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "set_store",
				arguments: { name: "nutty brown" },
				...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
			},
		],
		api: "openai-completions",
		provider: "google",
		model: "gemini-3-pro-preview",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: now,
	};
}

type AssistantWire = {
	role: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
		extra_content?: { google?: { thought_signature?: string } };
	}>;
	reasoning_details?: unknown;
};

describe("openai-completions convertMessages — Gemini 3 thought_signature round-trip", () => {
	it("attaches extra_content.google.thought_signature for bare base64 signatures", () => {
		const model = buildModel();
		const now = Date.now();
		const sig = "Ci4BV0gGcmFnbWVudCBzaWduYXR1cmU=";
		const context: Context = {
			messages: [
				{ role: "user", content: "set nutty brown as our store", timestamp: now - 1 },
				buildAssistantToolCall(sig, now),
			],
		};

		const messages = convertMessages(model, context, compat) as AssistantWire[];
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeTruthy();
		const tc = assistant?.tool_calls?.[0];
		expect(tc?.id).toBe("call_1");
		expect(tc?.extra_content?.google?.thought_signature).toBe(sig);
		// Bare signature must not be forwarded as a reasoning_details entry —
		// Gemini rejects that shape.
		expect(assistant?.reasoning_details).toBeUndefined();
	});

	it("omits extra_content when the stored signature is a JSON-wrapped reasoning.encrypted detail", () => {
		const model = buildModel();
		const now = Date.now();
		const encryptedDetail = JSON.stringify({
			type: "reasoning.encrypted",
			data: "enc-blob",
			format: "openai-responses-v1",
		});
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: now - 1 }, buildAssistantToolCall(encryptedDetail, now)],
		};

		const messages = convertMessages(model, context, compat) as AssistantWire[];
		const assistant = messages.find((m) => m.role === "assistant");
		const tc = assistant?.tool_calls?.[0];
		expect(tc).toBeTruthy();
		expect(tc?.extra_content).toBeUndefined();
		expect(Array.isArray(assistant?.reasoning_details)).toBe(true);
		expect((assistant?.reasoning_details as unknown[]).length).toBe(1);
	});

	it("omits extra_content when no signature was captured", () => {
		const model = buildModel();
		const now = Date.now();
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: now - 1 }, buildAssistantToolCall(undefined, now)],
		};

		const messages = convertMessages(model, context, compat) as AssistantWire[];
		const assistant = messages.find((m) => m.role === "assistant");
		const tc = assistant?.tool_calls?.[0];
		expect(tc).toBeTruthy();
		expect(tc?.extra_content).toBeUndefined();
		expect(assistant?.reasoning_details).toBeUndefined();
	});
});
