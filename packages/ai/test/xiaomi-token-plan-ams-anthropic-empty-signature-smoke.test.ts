import { describe, expect, it } from "vitest";
import { completeSimple, getEnvApiKey, streamSimple } from "../src/index.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

const provider = "xiaomi-token-plan-ams";
const apiKey = getEnvApiKey(provider);

const model: Model<"anthropic-messages"> = {
	id: "mimo-v2.5-pro",
	name: "MiMo-V2.5-Pro Anthropic smoke",
	api: "anthropic-messages",
	provider,
	baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 1024,
	compat: { allowEmptySignature: true },
};

interface AnthropicPayload {
	messages?: Array<{
		role: string;
		content: string | Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeInitialContext(): Context {
	return {
		systemPrompt: "You are concise. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content: "Think internally if you need to, then reply with exactly this text and nothing else: first-ok",
				timestamp: Date.now(),
			},
		],
	};
}

function getThinkingBlocks(message: AssistantMessage) {
	return message.content.filter((block) => block.type === "thinking");
}

async function captureReplayPayload(context: Context): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey,
		maxTokens: 512,
		reasoning: "high",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload capture before request");
	}
	return capturedPayload;
}

describe.skipIf(!apiKey)("Xiaomi Token Plan AMS Anthropic empty thinking signature smoke", () => {
	it("reproduces empty thinking signatures and preserves them for replay", { timeout: 60000, retry: 1 }, async () => {
		const firstContext = makeInitialContext();
		const first = await completeSimple(model, firstContext, {
			apiKey,
			maxTokens: 512,
			reasoning: "high",
		});

		expect(first.stopReason, first.errorMessage).toBe("stop");

		const thinkingBlocks = getThinkingBlocks(first);
		expect(thinkingBlocks.length).toBeGreaterThan(0);
		expect(thinkingBlocks.some((block) => block.thinkingSignature === "")).toBe(true);

		const replayContext: Context = {
			...firstContext,
			messages: [
				...firstContext.messages,
				first,
				{
					role: "user",
					content: "Reply with exactly this text and nothing else: second-ok",
					timestamp: Date.now(),
				},
			],
		};

		const replayPayload = await captureReplayPayload(replayContext);
		const assistantPayload = replayPayload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload).toBeDefined();
		expect(Array.isArray(assistantPayload!.content)).toBe(true);
		const replayedThinking = (assistantPayload!.content as Array<{ type: string; text?: string }>).filter(
			(block) => block.type === "thinking",
		);
		const replayedText = (assistantPayload!.content as Array<{ type: string; text?: string }>).filter(
			(block) => block.type === "text",
		);
		expect(replayedThinking).toEqual([{ type: "thinking", thinking: thinkingBlocks[0].thinking, signature: "" }]);
		expect(replayedText.some((block) => block.text === thinkingBlocks[0].thinking)).toBe(false);
	});
});
