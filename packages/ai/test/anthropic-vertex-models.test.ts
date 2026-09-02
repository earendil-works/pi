import { describe, expect, it } from "vitest";
import { getBuiltinModels } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";

function getAnthropicVertexModels(): Model<"anthropic-vertex">[] {
	const getVertexModels = getBuiltinModels as (provider: "anthropic-vertex") => Model<"anthropic-vertex">[];
	return getVertexModels("anthropic-vertex");
}

describe("Anthropic Vertex model metadata", () => {
	it("uses the active specialized Vertex catalog with official request IDs", () => {
		const models = getAnthropicVertexModels();
		const ids = models.map((model) => model.id);

		expect(ids).toEqual(
			expect.arrayContaining([
				"claude-haiku-4-5@20251001",
				"claude-fable-5",
				"claude-opus-4-5@20251101",
				"claude-opus-4-6",
				"claude-opus-4-7",
				"claude-opus-4-8",
				"claude-opus-5",
				"claude-sonnet-4-5@20250929",
				"claude-sonnet-4-6",
				"claude-sonnet-5",
			]),
		);
		expect(ids.some((id) => id.endsWith("@default"))).toBe(false);
		expect(ids.some((id) => id.includes("mythos"))).toBe(false);
		expect(ids).not.toContain("claude-opus-4@20250514");
		expect(ids).not.toContain("claude-sonnet-4@20250514");
		expect(models.every((model) => model.api === "anthropic-vertex")).toBe(true);
		expect(models.every((model) => model.provider === "anthropic-vertex")).toBe(true);
		expect(models.every((model) => model.baseUrl === "https://{location}-aiplatform.googleapis.com")).toBe(true);
		for (const model of models) {
			expect(Number.isFinite(model.contextWindow) && model.contextWindow > 0).toBe(true);
			expect(Number.isFinite(model.maxTokens) && model.maxTokens > 0).toBe(true);
			for (const cost of Object.values(model.cost)) {
				if (typeof cost === "number") expect(Number.isFinite(cost) && cost >= 0).toBe(true);
			}
		}
	});

	it("applies adaptive-thinking and sampling compatibility to current models", () => {
		const byId = new Map(getAnthropicVertexModels().map((model) => [model.id, model]));

		expect(byId.get("claude-fable-5")).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
			thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		});
		expect(byId.get("claude-opus-4-6")).toMatchObject({
			contextWindow: 1_000_000,
			compat: { forceAdaptiveThinking: true },
			thinkingLevelMap: { max: "max" },
		});
		expect(byId.get("claude-opus-4-8")).toMatchObject({
			contextWindow: 1_000_000,
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		expect(byId.get("claude-opus-5")).toMatchObject({
			contextWindow: 1_000_000,
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		expect(byId.get("claude-sonnet-5")).toMatchObject({
			contextWindow: 1_000_000,
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		expect(byId.get("claude-sonnet-4-6")).toMatchObject({
			contextWindow: 1_000_000,
			compat: { forceAdaptiveThinking: true },
			thinkingLevelMap: { max: "max" },
		});
	});

	it("does not infer unsupported Vertex tool compatibility", () => {
		for (const model of getAnthropicVertexModels()) {
			expect(model.compat?.supportsStrictTools).toBeUndefined();
			expect(model.compat?.supportsToolReferences).toBeUndefined();
		}
	});
});
