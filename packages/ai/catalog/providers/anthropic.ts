import type { Model } from "../../src/types.ts";
import { defineProvider, mergeCompat, mergeThinking, modelsDevModels, withInputLimits } from "../define.ts";
import {
	claude55ThinkingLevels,
	enableClaudeMidConvoEffort,
	supportsClaudeMidConvoEffort,
	supportsClaudeMidConvoSystemMessages,
} from "../families/anthropic.ts";

// Models the API may fall back to, with the price the caller is billed.
const ALLOWED_FALLBACK_MODELS: Record<string, string[]> = {
	"claude-fable-5": ["claude-opus-4-8", "claude-opus-5"],
	"claude-opus-5": ["claude-opus-4-8"],
};

const MODELS_WITH_1M_CONTEXT = new Set(["claude-opus-4-6", "claude-sonnet-4-6"]);
const MODELS_55 = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

export default defineProvider({
	id: "anthropic",
	models: (ctx) =>
		modelsDevModels(ctx, "anthropic", {
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			map: (model) => {
				if (MODELS_55.has(model.id)) mergeThinking(model, claude55ThinkingLevels(model.id));
				if (MODELS_WITH_1M_CONTEXT.has(model.id)) model.contextWindow = 1000000;
				return model;
			},
		}),
	finalize: (model) => {
		if (model.api !== "anthropic-messages") return;
		const messagesModel = model as Model<"anthropic-messages">;
		if (supportsClaudeMidConvoEffort(model.id)) enableClaudeMidConvoEffort(messagesModel);
		if (supportsClaudeMidConvoSystemMessages(model.id)) {
			mergeCompat(messagesModel, { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true });
		}
		mergeCompat(messagesModel, { supportsStrictTools: true });
		// Ephemeral entries have a hard five-minute lifetime; `ttl: "1h"` extends
		// it to one hour. Only direct Anthropic is annotated so cache warming does
		// not assume equivalent behavior through proxies.
		// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
		model.promptCache = { short: 300, long: 3600 };
		withInputLimits(model, {
			maxRequestBytes: 32 * 1024 * 1024,
			images: { maxPerRequest: model.contextWindow === 200000 ? 100 : 600 },
		});
	},
	finalizeAll: (models) => {
		const modelsById = new Map(models.map((model) => [model.id, model as Model<"anthropic-messages">]));
		for (const [modelId, fallbackModelIds] of Object.entries(ALLOWED_FALLBACK_MODELS)) {
			const model = modelsById.get(modelId);
			if (!model) continue;
			const compatibleFallbackModelIds = model.compat?.supportsMidConvoEffort
				? fallbackModelIds.filter(supportsClaudeMidConvoEffort)
				: fallbackModelIds;
			const allowedFallbackModels = compatibleFallbackModelIds.flatMap((fallbackModelId) => {
				const fallbackModel = modelsById.get(fallbackModelId);
				return fallbackModel
					? [{ provider: fallbackModel.provider, model: fallbackModel.id, cost: fallbackModel.cost }]
					: [];
			});
			if (allowedFallbackModels.length > 0) mergeCompat(model, { allowedFallbackModels });
		}
	},
});
