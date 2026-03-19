import { type Api, getModel, type Model } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

type MorphCompactionMode = "on" | "off" | "auto";

type MorphCompressionDecision =
	| {
			kind: "skip";
			targetTokens: number;
			estimatedHistoryTokens: number;
			reason: "under-target-budget" | "missing-context-window";
	  }
	| {
			kind: "compact";
			targetTokens: number;
			estimatedHistoryTokens: number;
			compressionRatio: number;
	  };

type MorphCompactionStrategy =
	| { kind: "skip-compaction"; reason: string }
	| { kind: "morph-compact"; effectiveMode: MorphCompactionMode; compressionRatio: number }
	| { kind: "native-replay-compact"; reason: string }
	| { kind: "local-summary-fallback"; reason: string };

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
	it("skips compaction when history already fits inside 40 percent of the context window", async () => {
		const mod = await loadMorphCompactionStrategyModule();
		expect(mod.selectMorphCompressionRatio({ estimatedHistoryTokens: 39_500, contextWindow: 100_000 })).toEqual({
			kind: "skip",
			targetTokens: 40_000,
			estimatedHistoryTokens: 39_500,
			reason: "under-target-budget",
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

	it("uses local summary fallback when Morph is disabled on a visible-history-safe path", async () => {
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
		).toMatchObject({ kind: "local-summary-fallback" });
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

	it("falls back when auto mode cannot use Morph because the key is absent", async () => {
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
		).toMatchObject({ kind: "local-summary-fallback" });
	});

	it("prefers native replay compaction when the current path requires opaque replay preservation", async () => {
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
		).toMatchObject({ kind: "native-replay-compact" });
	});
});
