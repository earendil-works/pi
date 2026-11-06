import { describe, expect, it } from "vitest";
import { resolveSamplingParams } from "../src/api/simple-options.ts";
import type { Api, Model } from "../src/types.ts";

function modelWith(overrides: Record<string, unknown>): Model<Api> {
	return {
		id: "test/model",
		name: "Test",
		api: "openai-completions",
		provider: "test",
		baseUrl: "http://127.0.0.1:1/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1000,
		maxTokens: 100,
		...overrides,
	} as unknown as Model<Api>;
}

describe("resolveSamplingParams reasoning effort", () => {
	it("translates a sampling literal that names a thinking level", () => {
		const model = modelWith({
			thinkingLevelMap: { off: null, low: "low", medium: "high", high: "high", max: "max" },
			samplingParams: { reasoning_effort: "medium" },
		});
		expect(resolveSamplingParams(model, "medium")?.reasoning_effort).toBe("high");
	});

	it("drops a literal the model marks unsupported", () => {
		const model = modelWith({
			thinkingLevelMap: { off: null, low: "low", medium: null, high: "high", max: "max" },
			samplingParams: { reasoning_effort: "medium" },
		});
		expect(resolveSamplingParams(model, "medium")).not.toHaveProperty("reasoning_effort");
	});

	it("keeps values that are not thinking level names", () => {
		const model = modelWith({
			thinkingLevelMap: { off: null, high: "high" },
			samplingParams: { reasoning_effort: "thorough", temperature: 0.2 },
		});
		const params = resolveSamplingParams(model, "off");
		expect(params?.reasoning_effort).toBe("thorough");
		expect(params?.temperature).toBe(0.2);
	});

	it("leaves models without a map unchanged", () => {
		const model = modelWith({ samplingParams: { reasoning_effort: "medium" } });
		expect(resolveSamplingParams(model, "medium")?.reasoning_effort).toBe("medium");
	});

	it("still lets request params override non-effort sampling", () => {
		const model = modelWith({
			thinkingLevelMap: { medium: "high" },
			samplingParams: { reasoning_effort: "medium", top_p: 0.5 },
		});
		const params = resolveSamplingParams(model, "medium", { top_p: 0.9 });
		expect(params?.reasoning_effort).toBe("high");
		expect(params?.top_p).toBe(0.9);
	});
});
