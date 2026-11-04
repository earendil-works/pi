// Model scope for cycling (pi's `enabledModels`, coding-agent core/model-resolver.ts `resolveModelScopeFromModels`),
// pure: patterns are `provider/modelId` or `modelId`, a case-insensitive `*`/`?` glob over either, each with an optional
// `:thinkingLevel` suffix. Exact references win over globs; duplicates keep their first position.
import type { ModelInfo } from "./contract.ts";

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type ScopedModel = { provider: string; modelId: string; thinkingLevel?: string };
export type ScopeResult = { models: ScopedModel[]; unmatched: string[] };

function glob(pattern: string): RegExp {
	const source = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${source}$`, "i");
}

function exact(reference: string, models: readonly ModelInfo[]): ModelInfo | undefined {
	const lower = reference.toLowerCase();
	return (
		models.find((model) => `${model.provider}/${model.modelId}`.toLowerCase() === lower) ??
		models.find((model) => model.modelId.toLowerCase() === lower)
	);
}

export function resolveModelScope(patterns: readonly string[], models: readonly ModelInfo[]): ScopeResult {
	const result: ScopeResult = { models: [], unmatched: [] };
	const add = (model: ModelInfo, thinkingLevel: string | undefined) => {
		if (result.models.some((item) => item.provider === model.provider && item.modelId === model.modelId)) return;
		result.models.push({
			provider: model.provider,
			modelId: model.modelId,
			...(thinkingLevel ? { thinkingLevel } : {}),
		});
	};
	for (const pattern of patterns) {
		let reference = pattern.trim();
		let level: string | undefined;
		// A model ID may contain colons (OpenRouter's `:exacto`): the whole pattern first, then a level suffix.
		const colon = reference.lastIndexOf(":");
		if (!exact(reference, models) && colon !== -1 && LEVELS.has(reference.slice(colon + 1))) {
			level = reference.slice(colon + 1);
			reference = reference.slice(0, colon);
		}
		const single = exact(reference, models);
		if (single) {
			add(single, level);
			continue;
		}
		if (!/[*?]/.test(reference)) {
			result.unmatched.push(pattern);
			continue;
		}
		const matcher = glob(reference);
		const matching = models.filter(
			(model) => matcher.test(`${model.provider}/${model.modelId}`) || matcher.test(model.modelId),
		);
		if (matching.length === 0) result.unmatched.push(pattern);
		for (const model of matching) add(model, level);
	}
	return result;
}
