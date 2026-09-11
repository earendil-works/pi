import { LM_STUDIO_COMPAT } from "../src/providers/lm-studio.ts";
import type { Model } from "../src/types.ts";

/** Base URL for the LM Studio server, read from env or defaulting to localhost. */
export function getLMStudioBaseUrl(): string {
	return process.env.LM_STUDIO_BASE_URL || "http://localhost:1234";
}

// use small model, trained for tool call for the tests
// if such model is not found - use the first available, so
// if there is a LM Studio started with only one model it will work
const LM_STUDIO_TEST_MODEL_KEY = "qwen/qwen3-4b-thinking-2507";

/** Resolve the first model id loaded in a running LM Studio server, or undefined. */
export async function getLMStudioModelId(): Promise<string | undefined> {
	try {
		const baseUrl = getLMStudioBaseUrl();
		const response = await fetch(`${baseUrl}/api/v1/models`);
		if (!response.ok) return undefined;
		const payload = (await response.json()) as { models?: Array<{ key: string }> };
		const entries = Array.isArray(payload?.models) ? payload.models : [];
		const first = // a small llm with tools capability or the first non-empty
			entries.find((entry) => entry.key === LM_STUDIO_TEST_MODEL_KEY) ||
			entries.find((entry) => entry.key.trim() !== "");
		return typeof first?.key === "string" ? first.key : undefined;
	} catch {
		return undefined;
	}
}

/** Build the standard inline LM Studio test model for a loaded model id. */
export function lmStudioTestModel(id: string): Model<"openai-responses"> {
	const baseUrl = getLMStudioBaseUrl();
	return {
		id,
		name: "LM Studio Local Model",
		api: "openai-responses",
		provider: "lm-studio",
		baseUrl: `${baseUrl}/v1`,
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: LM_STUDIO_COMPAT,
	};
}

let cachedLMStudioModel: Model<"openai-responses"> | undefined;

/**
 * Resolve the LM Studio test model once per module, throwing when the server
 * is unreachable or has no loaded model. Use inside test bodies (not hooks)
 * to keep `describe.skipIf` blocks free of duplicate beforeAll/afterAll.
 */
export async function resolveLMStudioTestModel(): Promise<Model<"openai-responses">> {
	if (cachedLMStudioModel) return cachedLMStudioModel;
	const modelId = await getLMStudioModelId();
	if (!modelId) {
		throw new Error("LM Studio server is running but has no models loaded");
	}
	cachedLMStudioModel = lmStudioTestModel(modelId);
	return cachedLMStudioModel;
}
