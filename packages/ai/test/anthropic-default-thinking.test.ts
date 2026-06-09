import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "vendor--anthropic-compat",
		name: "Vendor Anthropic Compat",
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
	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});
	await s.result();
	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return capturedPayload;
}

describe("Anthropic defaultThinkingEnabled compat", () => {
	it("enables thinking with no reasoning level when compat.defaultThinkingEnabled is true", async () => {
		const payload = await capturePayload(makeCustomModel({ defaultThinkingEnabled: true }));
		expect(payload.thinking?.type).toBe("enabled");
	});

	it("leaves thinking off with no reasoning level when the flag is not set", async () => {
		const payload = await capturePayload(makeCustomModel());
		expect(payload.thinking).toEqual({ type: "disabled" });
	});

	it("defaults thinking on for the built-in MiniMax-M3 model", async () => {
		const payload = await capturePayload(getModel("minimax", "MiniMax-M3"));
		expect(payload.thinking?.type).toBe("enabled");
	});

	it("still honors an explicit reasoning level over the default", async () => {
		const payload = await capturePayload(getModel("minimax", "MiniMax-M3"), { reasoning: "medium" });
		expect(payload.thinking?.type).toBe("enabled");
	});
});
