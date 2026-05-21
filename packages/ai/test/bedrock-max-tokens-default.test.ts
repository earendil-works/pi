import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model } from "../src/types.ts";

interface BedrockInferencePayload {
	inferenceConfig?: {
		maxTokens?: number;
		temperature?: number;
	};
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockInferencePayload> {
	let capturedPayload: BedrockInferencePayload | undefined;
	const s = streamBedrock(model, makeContext(), {
		...options,
		onPayload: (payload) => {
			capturedPayload = payload as BedrockInferencePayload;
			throw new PayloadCaptured();
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

describe("Bedrock inferenceConfig.maxTokens default", () => {
	// Regression: when callers (notably the coding-agent loop) do not pass an
	// explicit maxTokens, the Bedrock Converse API silently caps output at its
	// server-side default (~4096 tokens). This produces stopReason "length"
	// mid-response, which the agent loop treats as a normal stop. The
	// Anthropic-native provider already defaults to model.maxTokens; Bedrock
	// should match that behaviour so the same model is not artificially
	// truncated when accessed via Bedrock.
	it("defaults inferenceConfig.maxTokens to model.maxTokens when caller omits maxTokens", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(model.maxTokens).toBeGreaterThan(4096); // sanity: registry has the real cap

		const payload = await capturePayload(model);

		expect(payload.inferenceConfig?.maxTokens).toBe(model.maxTokens);
	});

	it("preserves an explicit caller-supplied maxTokens", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

		const payload = await capturePayload(model, { maxTokens: 1234 });

		expect(payload.inferenceConfig?.maxTokens).toBe(1234);
	});
});
