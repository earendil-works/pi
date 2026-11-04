import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider } from "../define.ts";

const COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	thinkingFormat: "deepseek",
	supportsStrictMode: true,
	supportsLongCacheRetention: false,
};

// Thinking is either off or high. Hiding the lower levels makes pi clamp them to
// high; off is unmapped, so a request without reasoning sends thinking disabled.
const ANT_LING_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
} as const;

function model(
	id: string,
	name: string,
	input: ["text"] | ["text", "image"],
	contextWindow: number,
	cost: Model<"openai-completions">["cost"],
) {
	return {
		id,
		name,
		api: "openai-completions",
		baseUrl: "https://api.ant-ling.com/v1",
		provider: "ant-ling",
		reasoning: true,
		thinkingLevelMap: ANT_LING_THINKING_LEVEL_MAP,
		input,
		cost,
		contextWindow,
		maxTokens: 262144,
	} satisfies Model<"openai-completions">;
}

export default defineProvider({
	id: "ant-ling",
	models: () => [
		model("Ling-3.1-flash", "Ling 3.1 Flash", ["text"], 1000000, {
			input: 0.075,
			output: 0.225,
			cacheRead: 0.015,
			cacheWrite: 0,
		}),
		model("Ling-3.0-flash-VL", "Ling 3.0 Flash VL", ["text", "image"], 262144, {
			input: 0.021,
			output: 0.062,
			cacheRead: 0.0042,
			cacheWrite: 0,
		}),
		model("Ling-3.0-flash", "Ling 3.0 Flash", ["text"], 262144, {
			input: 0.0168,
			output: 0.0504,
			cacheRead: 0.0034,
			cacheWrite: 0,
		}),
	],
	compat: {
		"openai-completions": COMPAT,
	},
});
