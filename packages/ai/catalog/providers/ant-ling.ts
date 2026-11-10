import type { Model, ModelInputModality, ThinkingLevelMap } from "../../src/types.ts";
import { defineProvider } from "../define.ts";

// Ling 3.x exposes a thinking on/off toggle, not effort levels.
const THINKING_LEVELS: ThinkingLevelMap = {
	off: "off",
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: null,
};

function model(
	id: string,
	name: string,
	cost: Model<"openai-completions">["cost"],
	contextWindow: number,
	maxTokens: number,
	input: ModelInputModality[] = ["text"],
) {
	return {
		id,
		name,
		api: "openai-completions",
		baseUrl: "https://api.ant-ling.com/v1",
		provider: "ant-ling",
		reasoning: true,
		input,
		cost,
		contextWindow,
		maxTokens,
		thinkingLevelMap: THINKING_LEVELS,
	} satisfies Model<"openai-completions">;
}

export default defineProvider({
	id: "ant-ling",
	models: () => [
		model(
			"Ling-3.2-flash",
			"Ling 3.2 Flash",
			{ input: 0.075, output: 0.225, cacheRead: 0.015, cacheWrite: 0 },
			1_000_000,
			262_144,
			["text", "image"],
		),
		model(
			"Ling-3.1-flash",
			"Ling 3.1 Flash",
			{ input: 0.075, output: 0.225, cacheRead: 0.015, cacheWrite: 0 },
			1_000_000,
			262_144,
		),
		model(
			"Ling-3.0-flash",
			"Ling 3.0 Flash",
			{ input: 0.021, output: 0.063, cacheRead: 0.0042, cacheWrite: 0 },
			262_144,
			32_768,
		),
	],
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "deepseek",
			supportsStrictMode: true,
			supportsLongCacheRetention: false,
		},
	},
});
