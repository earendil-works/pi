import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface AnthropicMessagesPayload {
	messages?: Array<{
		role: string;
		content: Array<{
			type: string;
			thinking?: string;
			signature?: string;
			text?: string;
		}>;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeCustomModel(allowEmptySignature?: boolean): Model<"anthropic-messages"> {
	return {
		id: "vendor--claude-opus",
		name: "Vendor Claude Opus",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { allowEmptySignature },
	};
}

function makeContextWithThinkingBlock(thinkingSignature: string): Context {
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "Let me think about this...",
				thinkingSignature,
			},
		],
		provider: "vendor-proxy",
		api: "anthropic-messages",
		model: "vendor--claude-opus",
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
			{ role: "user", content: "Hello", timestamp: Date.now() },
			assistantMessage,
			{ role: "user", content: "Continue", timestamp: Date.now() },
		],
	};
}

async function captureMessages(
	model: Model<"anthropic-messages">,
	context: Context,
): Promise<AnthropicMessagesPayload> {
	let capturedPayload: AnthropicMessagesPayload | undefined;

	const { streamSimple } = await import("../src/stream.ts");

	const s = streamSimple(model, context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicMessagesPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic allowEmptySignature compat option", () => {
	it("converts thinking blocks with empty signature to text by default", async () => {
		const model = makeCustomModel(); // allowEmptySignature undefined/false
		const context = makeContextWithThinkingBlock(""); // empty signature

		const payload = await captureMessages(model, context);

		const assistantMsg = payload.messages?.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		expect(assistantMsg!.content).toHaveLength(1);
		expect(assistantMsg!.content[0].type).toBe("text");
		expect(assistantMsg!.content[0].text).toBe("Let me think about this...");
	});

	it("preserves thinking block with empty signature when allowEmptySignature is true", async () => {
		const model = makeCustomModel(true);
		const context = makeContextWithThinkingBlock(""); // empty signature

		const payload = await captureMessages(model, context);

		const assistantMsg = payload.messages?.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		expect(assistantMsg!.content).toHaveLength(1);
		expect(assistantMsg!.content[0].type).toBe("thinking");
		expect(assistantMsg!.content[0].thinking).toBe("Let me think about this...");
		expect(assistantMsg!.content[0].signature).toBe("");
	});

	it("preserves thinking block with valid signature regardless of allowEmptySignature", async () => {
		const model = makeCustomModel(false);
		const context = makeContextWithThinkingBlock("valid-signature-123");

		const payload = await captureMessages(model, context);

		const assistantMsg = payload.messages?.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		expect(assistantMsg!.content).toHaveLength(1);
		expect(assistantMsg!.content[0].type).toBe("thinking");
		expect(assistantMsg!.content[0].thinking).toBe("Let me think about this...");
		expect(assistantMsg!.content[0].signature).toBe("valid-signature-123");
	});
});
