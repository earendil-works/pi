import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/stream.ts";
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
		id: "mimo-v2.5-pro",
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

function makeContext(thinkingSignature: string): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature }],
		provider: "xiaomi-token-plan-ams",
		api: "anthropic-messages",
		model: "mimo-v2.5-pro",
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

	it("preserves empty-signature thinking when allowEmptySignature is enabled", async () => {
		const payload = await capturePayload(makeModel(true), makeContext(" "));
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([{ type: "thinking", thinking: "internal reasoning", signature: "" }]);
	});
});
