import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Api, Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface SamplingPayload {
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
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

function makeCompletionsModel(overrides?: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		id: "custom-model",
		name: "Custom Model",
		api: "openai-completions",
		provider: "custom-provider",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

function makeAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "vendor--claude",
		name: "Vendor Proxy Claude",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

async function capturePayload(model: Model<Api>, options?: SimpleStreamOptions): Promise<SamplingPayload> {
	let capturedPayload: SamplingPayload | undefined;

	const s = streamSimple(model, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as SamplingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("sampling params", () => {
	it("merges stream-option sampling params into the request body", async () => {
		const payload = await capturePayload(makeCompletionsModel(), {
			samplingParams: { top_p: 0.95, top_k: 0, min_p: 0 },
		});

		expect(payload.top_p).toBe(0.95);
		expect(payload.top_k).toBe(0);
		expect(payload.min_p).toBe(0);
	});

	it("omits sampling params when neither options nor model set them", async () => {
		const payload = await capturePayload(makeCompletionsModel());

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
	});

	it("applies model-level sampling params", async () => {
		const payload = await capturePayload(makeCompletionsModel({ samplingParams: { temperature: 1, top_p: 0.95 } }));

		expect(payload.temperature).toBe(1);
		expect(payload.top_p).toBe(0.95);
	});

	it("merges stream-option keys over model-level keys", async () => {
		const payload = await capturePayload(makeCompletionsModel({ samplingParams: { top_p: 0.95, min_p: 0.05 } }), {
			samplingParams: { top_p: 0.5 },
		});

		expect(payload.top_p).toBe(0.5);
		expect(payload.min_p).toBe(0.05);
	});

	it("overrides named request fields", async () => {
		const payload = await capturePayload(makeCompletionsModel(), {
			temperature: 0,
			samplingParams: { temperature: 1 },
		});

		expect(payload.temperature).toBe(1);
	});

	it("is ignored by non-OpenAI-compatible APIs", async () => {
		const payload = await capturePayload(makeAnthropicModel(), {
			samplingParams: { top_p: 0.9, top_k: 40 },
		});

		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
	});
});
