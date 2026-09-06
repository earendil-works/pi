import type { Api, Model } from "../src/types.ts";

type LimitFields = Pick<Model<Api>, "provider" | "id" | "maxTokens" | "contextWindow">;

/**
 * OpenRouter `:free` routes often advertise larger context/output limits than the
 * matching base entry. Pi then sends that inflated `maxTokens` as `max_tokens`,
 * and upstream providers reject the request (HTTP 400).
 *
 * Example from #8760: `minimax/minimax-m3:free` advertised maxTokens 943718 while
 * `minimax/minimax-m3` is 512000; GMICloud rejects anything above 524288.
 *
 * Clamp free-variant limits down to the base model when both are present.
 * Mutates models in place (same pattern as other catalog overrides).
 */
export function clampOpenRouterFreeVariantLimits<T extends LimitFields>(models: T[]): T[] {
	const openrouterById = new Map<string, T>();
	for (const model of models) {
		if (model.provider === "openrouter") {
			openrouterById.set(model.id, model);
		}
	}

	for (const model of models) {
		if (model.provider !== "openrouter" || !model.id.endsWith(":free")) continue;
		const base = openrouterById.get(model.id.slice(0, -":free".length));
		if (!base) continue;
		if (model.maxTokens > base.maxTokens) {
			model.maxTokens = base.maxTokens;
		}
		if (model.contextWindow > base.contextWindow) {
			model.contextWindow = base.contextWindow;
		}
	}

	return models;
}
