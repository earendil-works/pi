import { type Api, getModel, type Model } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

type MorphCompactionMode = "on" | "off" | "auto";

type MorphCompressionDecision =
	| {
			kind: "cannot-compact";
			targetTokens: number;
			estimatedHistoryTokens: number;
			reason: "missing-context-window";
	  }
	| {
			kind: "compact";
			targetTokens: number;
			estimatedHistoryTokens: number;
			compressionRatio: number;
	  };

type MorphCompactionStrategy =
	| { kind: "morph-compact"; effectiveMode: MorphCompactionMode; compressionRatio: number }
	| { kind: "cannot-compact"; reason: string };

type MorphCompactionStrategyModule = {
	selectMorphCompressionRatio(args: {
		estimatedHistoryTokens: number;
		contextWindow: number;
	}): MorphCompressionDecision;
	selectCompactionStrategy(args: {
		model: Model<Api>;
		morphMode: MorphCompactionMode;
		hasMorphApiKey: boolean;
		requiresNativeReplay: boolean;
		estimatedHistoryTokens: number;
		contextWindow: number;
	}): MorphCompactionStrategy;
};

async function loadMorphCompactionStrategyModule(): Promise<MorphCompactionStrategyModule> {
	return (await import("../src/morph-compaction-strategy.js")) as MorphCompactionStrategyModule;
}

function requireModel(provider: Parameters<typeof getModel>[0], modelId: string): Model<Api> {
	const model = getModel(provider, modelId);
	expect(model).toBeTruthy();
	if (!model) {
		throw new Error(`Required test model is missing: ${provider}/${modelId}`);
	}
	return model;
}

describe("selectMorphCompressionRatio", () => {
	it("still returns a valid Morph ratio when history is already under the 40 percent target", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(mod.selectMorphCompressionRatio({ estimatedHistoryTokens: 39_500, contextWindow: 100_000 })).toEqual({
			kind: "compact",
			targetTokens: 40_000,
			estimatedHistoryTokens: 39_500,
			compressionRatio: 0.7,
		});
	});

	it("clamps slight overflow to the maximum 0.7 ratio", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(mod.selectMorphCompressionRatio({ estimatedHistoryTokens: 55_000, contextWindow: 100_000 })).toEqual({
			kind: "compact",
			targetTokens: 40_000,
			estimatedHistoryTokens: 55_000,
			compressionRatio: 0.7,
		});
	});

	it("returns a midrange ratio when the target keep fraction lands inside the clamp range", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(mod.selectMorphCompressionRatio({ estimatedHistoryTokens: 100_000, contextWindow: 100_000 })).toEqual({
			kind: "compact",
			targetTokens: 40_000,
			estimatedHistoryTokens: 100_000,
			compressionRatio: 0.4,
		});
	});

	it("clamps extreme overflow to the minimum 0.3 ratio", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(mod.selectMorphCompressionRatio({ estimatedHistoryTokens: 500_000, contextWindow: 100_000 })).toEqual({
			kind: "compact",
			targetTokens: 40_000,
			estimatedHistoryTokens: 500_000,
			compressionRatio: 0.3,
		});
	});
});

describe("selectCompactionStrategy", () => {
	const anthropicModel = requireModel("anthropic", "claude-sonnet-4-5");
	const openaiModel = requireModel("openai", "gpt-4o-mini");

	it("fails when Morph is disabled on a visible-history-safe path", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(
			mod.selectCompactionStrategy({
				model: anthropicModel,
				morphMode: "off",
				hasMorphApiKey: true,
				requiresNativeReplay: false,
				estimatedHistoryTokens: 100_000,
				contextWindow: 100_000,
			}),
		).toMatchObject({ kind: "cannot-compact" });
	});

	it("uses Morph when forced on and the API key is available", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(
			mod.selectCompactionStrategy({
				model: anthropicModel,
				morphMode: "on",
				hasMorphApiKey: true,
				requiresNativeReplay: false,
				estimatedHistoryTokens: 100_000,
				contextWindow: 100_000,
			}),
		).toEqual({ kind: "morph-compact", effectiveMode: "on", compressionRatio: 0.4 });
	});

	it("uses Morph in auto mode when the key is present and native replay is not required", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(
			mod.selectCompactionStrategy({
				model: anthropicModel,
				morphMode: "auto",
				hasMorphApiKey: true,
				requiresNativeReplay: false,
				estimatedHistoryTokens: 100_000,
				contextWindow: 100_000,
			}),
		).toEqual({ kind: "morph-compact", effectiveMode: "auto", compressionRatio: 0.4 });
	});

	it("fails when auto mode cannot use Morph because the key is absent", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(
			mod.selectCompactionStrategy({
				model: anthropicModel,
				morphMode: "auto",
				hasMorphApiKey: false,
				requiresNativeReplay: false,
				estimatedHistoryTokens: 100_000,
				contextWindow: 100_000,
			}),
		).toMatchObject({ kind: "cannot-compact" });
	});

	it("fails when the current path requires opaque native replay preservation", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(
			mod.selectCompactionStrategy({
				model: openaiModel,
				morphMode: "auto",
				hasMorphApiKey: true,
				requiresNativeReplay: true,
				estimatedHistoryTokens: 100_000,
				contextWindow: 100_000,
			}),
		).toMatchObject({ kind: "cannot-compact" });
	});
});
