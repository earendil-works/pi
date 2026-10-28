import { describe, expect, it } from "vitest";
import { getModel, getModels, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface AnthropicPayload {
	messages?: Array<{
		role: string;
		content: Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeModel(allowEmptySignature?: boolean): Model<"anthropic-messages"> {
	return {
		id: "mimo-v2.6-pro",
		name: "MiMo-V2.5-Pro",
		api: "anthropic-messages",
		provider: "xiaomi-token-plan-ams",
		baseUrl: "http://127.0.0.1:9/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 1024,
		...(allowEmptySignature === undefined ? {} : { compat: { allowEmptySignature } }),
	};
}

function makeContext(
	thinkingSignature: string,
	thinking = "internal reasoning",
	provider = "xiaomi-token-plan-ams",
	model = "mimo-v2.6-pro",
): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking, thinkingSignature }],
		provider,
		api: "anthropic-messages",
		model,
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
	return {
		messages: [
			{ role: "user", content: "first", timestamp: Date.now() },
			assistant,
			{ role: "user", content: "second", timestamp: Date.now() },
		],
	};
}

async function capturePayload(model: Model<"anthropic-messages">, context: Context): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected payload capture before request");
	return capturedPayload;
}

describe("Anthropic empty thinking signature compat", () => {
	it("converts empty-signature thinking to text by default", async () => {
		const payload = await capturePayload(makeModel(), makeContext(""));
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([{ type: "text", text: "internal reasoning" }]);
	});

	it("preserves empty thinking text when the signature is present", async () => {
		const payload = await capturePayload(makeModel(), makeContext("signed-thinking", ""));
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([{ type: "thinking", thinking: "", signature: "signed-thinking" }]);
	});

	it("preserves empty-signature thinking when allowEmptySignature is enabled", async () => {
		const payload = await capturePayload(makeModel(true), makeContext(" "));
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([{ type: "thinking", thinking: "internal reasoning", signature: "" }]);
	});

	// Regression for #9676: Vercel AI Gateway emits unsigned thinking for translated models.
	it("allows empty thinking signatures for every Vercel AI Gateway model", () => {
		const models = getModels("vercel-ai-gateway");
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.compat?.allowEmptySignature === true)).toBe(true);
	});

	// Regression for #9323: Fireworks emits unsigned thinking that must survive replay.
	it.each([
		"accounts/fireworks/models/deepseek-v4p1-flash",
		"accounts/fireworks/models/qwen3p8-max",
		"accounts/fireworks/models/qwen3p8-2p4t-a95b",
		"accounts/fireworks/models/nemotron-3-ultra-nvfp4",
	] as const)("preserves unsigned thinking for Fireworks %s", async (modelId) => {
		const model = getModel("fireworks", modelId);
		expect(model.compat?.allowEmptySignature).toBe(true);
		const context = makeContext("", "internal reasoning", "fireworks", modelId);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content.push({ type: "text", text: "answer" });
		const payload = await capturePayload(model, context);
		expect(payload.messages?.find((message) => message.role === "assistant")?.content).toEqual([
			{ type: "thinking", thinking: "internal reasoning", signature: "" },
			{ type: "text", text: "answer" },
		]);
	});
});
