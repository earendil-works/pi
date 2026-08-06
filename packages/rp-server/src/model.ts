import type { Model } from "@earendil-works/pi-ai";
import type { RpModelConfig } from "./protocol.ts";

export function createRpModel(config: RpModelConfig): Model<string> {
	return {
		id: config.id,
		name: config.id,
		api: config.api ?? "openai-completions",
		provider: config.provider ?? "custom",
		baseUrl: config.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow ?? 128000,
		maxTokens: config.maxTokens ?? 16384,
	};
}
