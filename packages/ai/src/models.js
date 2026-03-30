import { MODELS } from "./models.generated.js";

const modelRegistry = new Map();
// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model);
	}
	modelRegistry.set(provider, providerModels);
}
export function getModel(provider, modelId) {
	return modelRegistry.get(provider)?.get(modelId);
}
export function getProviders() {
	return Array.from(modelRegistry.keys());
}
export function getModels(provider) {
	const models = modelRegistry.get(provider);
	return models ? Array.from(models.values()) : [];
}
export function calculateCost(model, usage) {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}
/** Models that support xhigh thinking level */
const XHIGH_MODELS = new Set([
	"gpt-5.1-codex-max",
	"gpt-5.2",
	"gpt-5.2-codex",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"gpt-5.4",
]);
/**
 * Check if a model supports xhigh thinking level.
 * Currently only certain OpenAI models support this.
 */
export function supportsXhigh(model) {
	return XHIGH_MODELS.has(model.id);
}
//# sourceMappingURL=models.js.map
