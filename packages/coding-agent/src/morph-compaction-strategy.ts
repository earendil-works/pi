import type { Api, Model } from "@kennyfrc/mu-ai";

import type { MorphCompactionMode } from "./morph-compaction-mode.js";

const MORPH_TARGET_CONTEXT_FRACTION = 0.4;
const MORPH_MIN_COMPRESSION_RATIO = 0.3;
const MORPH_MAX_COMPRESSION_RATIO = 0.7;

export type MorphCompressionDecision =
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

export type MorphCompactionStrategy =
	| { kind: "morph-compact"; effectiveMode: MorphCompactionMode; compressionRatio: number }
	| { kind: "cannot-compact"; reason: string };

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function hasUsableContextWindow(contextWindow: number): boolean {
	return Number.isFinite(contextWindow) && contextWindow > 0;
}

export function selectMorphCompressionRatio(args: {
	estimatedHistoryTokens: number;
	contextWindow: number;
}): MorphCompressionDecision {
	const estimatedHistoryTokens = Math.max(0, Math.round(args.estimatedHistoryTokens));
	if (!hasUsableContextWindow(args.contextWindow)) {
		return {
			kind: "cannot-compact",
			targetTokens: 0,
			estimatedHistoryTokens,
			reason: "missing-context-window",
		};
	}

	const targetTokens = Math.round(args.contextWindow * MORPH_TARGET_CONTEXT_FRACTION);
	const safeEstimatedHistoryTokens = Math.max(estimatedHistoryTokens, 1);
	const rawCompressionRatio = targetTokens / safeEstimatedHistoryTokens;
	const compressionRatio = clamp(rawCompressionRatio, MORPH_MIN_COMPRESSION_RATIO, MORPH_MAX_COMPRESSION_RATIO);

	return {
		kind: "compact",
		targetTokens,
		estimatedHistoryTokens,
		compressionRatio,
	};
}

export function selectCompactionStrategy(args: {
	model: Model<Api>;
	morphMode: MorphCompactionMode;
	hasMorphApiKey: boolean;
	requiresNativeReplay: boolean;
	estimatedHistoryTokens: number;
	contextWindow: number;
}): MorphCompactionStrategy {
	if (args.requiresNativeReplay) {
		return {
			kind: "cannot-compact",
			reason: `${args.model.provider}/${args.model.id} requires native replay preservation, so Morph-only compaction must fail`,
		};
	}

	const ratioDecision = selectMorphCompressionRatio({
		estimatedHistoryTokens: args.estimatedHistoryTokens,
		contextWindow: args.contextWindow,
	});
	if (ratioDecision.kind === "cannot-compact") {
		return {
			kind: "cannot-compact",
			reason: "No usable context window is available for Morph ratio selection",
		};
	}

	if (args.morphMode === "off") {
		return {
			kind: "cannot-compact",
			reason: "Morph compaction is disabled",
		};
	}

	if (!args.hasMorphApiKey) {
		return {
			kind: "cannot-compact",
			reason:
				args.morphMode === "on"
					? "Morph compaction was forced on but MORPH_API_KEY is missing"
					: "Morph compaction is unavailable because MORPH_API_KEY is missing",
		};
	}

	return {
		kind: "morph-compact",
		effectiveMode: args.morphMode,
		compressionRatio: ratioDecision.compressionRatio,
	};
}
