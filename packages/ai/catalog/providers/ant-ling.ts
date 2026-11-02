import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider, mergeThinking } from "../define.ts";

const COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsLongCacheRetention: false,
};

function model(id: string, name: string, reasoning: boolean, cost: Model<"openai-completions">["cost"]) {
	return {
		id,
		name,
		api: "openai-completions",
		baseUrl: "https://api.ant-ling.com/v1",
		provider: "ant-ling",
		reasoning,
		input: ["text"],
		cost,
		contextWindow: 262144,
		maxTokens: 65536,
		compat: reasoning ? { ...COMPAT, thinkingFormat: "ant-ling" } : COMPAT,
	} satisfies Model<"openai-completions">;
}

export default defineProvider({
	id: "ant-ling",
	models: () => [
		model("Ling-2.6-flash", "Ling 2.6 Flash", false, { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 }),
		model("Ling-2.6-1T", "Ling 2.6 1T", false, { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 }),
		model("Ring-2.6-1T", "Ring 2.6 1T", true, { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 }),
	],
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "ant-ling",
			supportsStrictMode: true,
			supportsLongCacheRetention: false,
		},
	},
	finalize: (model) => {
		// Ring reasons by default. Only high/xhigh have documented explicit effort controls.
		if (model.reasoning) {
			mergeThinking(model, { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh" });
		}
	},
});
