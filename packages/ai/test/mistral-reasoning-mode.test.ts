import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/mistral-conversations.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface MistralPayload {
	promptMode?: "reasoning";
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	promptCacheKey?: string;
}

function makeModel(
	id: string,
	reasoning: boolean,
	thinkingLevelMap?: Record<string, string | null>,
): Model<"mistral-conversations"> {
	return {
		id,
		name: id,
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "http://127.0.0.1:9",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		thinkingLevelMap,
	};
}

// Sparse none/high map (auto-generated from models.dev reasoning_options: ["none","high"]).
const NONE_HIGH_MAP: Record<string, string | null> = {
	off: "none",
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: null,
};

// Identity map: zai-glm-5-2 accepts all seven effort values.
const GLM_5_2_MAP: Record<string, string | null> = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

// zai-glm-5-3 cannot disable thinking (lowest accepted is "low").
// off:null makes "off" unselectable; a programmatic "off" clamps up to "low".
const GLM_5_3_MAP: Record<string, string | null> = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "high",
	high: "high",
	xhigh: "max",
	max: "max",
};

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"mistral-conversations">,
	options?: SimpleStreamOptions,
): Promise<MistralPayload> {
	let capturedPayload: MistralPayload | undefined;
	const stream = streamSimple(model, normalizeContext(makeContext()), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as MistralPayload;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Mistral reasoning mode selection", () => {
	it("uses reasoning_effort for Mistral Small 4", async () => {
		const payload = await capturePayload(makeModel("mistral-small-2603", true, NONE_HIGH_MAP), {
			reasoning: "medium",
		});

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits reasoning controls for Mistral Small 4 when thinking is off", async () => {
		const payload = await capturePayload(makeModel("mistral-small-2603", true, NONE_HIGH_MAP));

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("uses prompt_mode for Magistral reasoning models", async () => {
		const payload = await capturePayload(makeModel("magistral-medium-latest", true), { reasoning: "medium" });

		expect(payload.promptMode).toBe("reasoning");
		expect(payload.reasoningEffort).toBeUndefined();
	});

	// Regression for #9375: Mistral-hosted GLM-5.2 ignores prompt_mode.
	describe("zai-glm-5-2", () => {
		it("uses reasoning_effort when thinking is enabled", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-2", true, GLM_5_2_MAP), { reasoning: "medium" });

			// Identity map: medium maps to "medium" (all seven efforts accepted by 5-2).
			expect(payload.reasoningEffort).toBe("medium");
			expect(payload.promptMode).toBeUndefined();
		});

		it("omits reasoning controls when thinking is off", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-2", true, GLM_5_2_MAP));

			expect(payload.reasoningEffort).toBeUndefined();
			expect(payload.promptMode).toBeUndefined();
		});
	});

	// Regression for #9678: add zai-glm-5-3 to the mistral catalog.
	describe("zai-glm-5-3", () => {
		it("uses reasoning_effort when thinking is enabled", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-3", true, GLM_5_3_MAP), { reasoning: "high" });

			expect(payload.reasoningEffort).toBe("high");
			expect(payload.promptMode).toBeUndefined();
		});

		it("omits reasoning_effort when no thinking level is requested", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-3", true, GLM_5_3_MAP));

			expect(payload.reasoningEffort).toBeUndefined();
			expect(payload.promptMode).toBeUndefined();
		});

		it("clamps off to low since thinking cannot be disabled", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-3", true, GLM_5_3_MAP), {
				reasoning: "off",
			});

			expect(payload.reasoningEffort).toBe("low");
			expect(payload.promptMode).toBeUndefined();
		});
	});

	// Regression for #8700: Medium aliases must use reasoning_effort, not Magistral's prompt_mode.
	describe.each(["mistral-medium-2604", "mistral-medium-latest"] as const)("%s", (modelId) => {
		it("uses reasoning_effort when thinking is enabled", async () => {
			const payload = await capturePayload(makeModel(modelId, true, NONE_HIGH_MAP), { reasoning: "medium" });

			expect(payload.reasoningEffort).toBe("high");
			expect(payload.promptMode).toBeUndefined();
		});

		it("omits reasoning controls when thinking is off", async () => {
			const payload = await capturePayload(makeModel(modelId, true, NONE_HIGH_MAP));

			expect(payload.reasoningEffort).toBeUndefined();
			expect(payload.promptMode).toBeUndefined();
		});
	});

	// Regression for #8700: the Medium prefix must still respect the model's reasoning capability.
	it("omits reasoning controls for non-reasoning Medium models", async () => {
		const payload = await capturePayload(makeModel("mistral-medium-2505", false), { reasoning: "medium" });

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("uses the session id as prompt cache key", async () => {
		const payload = await capturePayload(makeModel("mistral-large-latest", false), {
			sessionId: "session-123",
		});

		expect(payload.promptCacheKey).toBe("session-123");
	});

	it("omits prompt cache key when cache retention is disabled", async () => {
		const payload = await capturePayload(makeModel("mistral-large-latest", false), {
			sessionId: "session-123",
			cacheRetention: "none",
		});

		expect(payload.promptCacheKey).toBeUndefined();
	});
});
