import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, SimpleStreamOptions } from "../src/types.js";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		// Id intentionally does not match any built-in adaptive substring
		// (opus-4-6, opus-4-7, sonnet-4-6). This mirrors corporate proxy
		// schemes such as `anthropic--claude-opus-latest`.
		id: "vendor--claude-opus-latest",
		name: "Vendor Proxy Opus Latest",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;

	const s = streamSimple(model, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic forceAdaptiveThinking compat override", () => {
	it("sends legacy thinking payload for custom model ids by default", async () => {
		const payload = await capturePayload(makeCustomModel(), { reasoning: "medium" });

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.output_config).toBeUndefined();
	});

	it("sends adaptive thinking payload when compat.forceAdaptiveThinking is true", async () => {
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: true }), { reasoning: "medium" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "medium" });
	});

	it("forces legacy thinking payload when compat.forceAdaptiveThinking is false", async () => {
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: false }), { reasoning: "medium" });

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.output_config).toBeUndefined();
	});

	it("preserves thinking.type=disabled when reasoning is off regardless of override", async () => {
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: true }));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});
});
