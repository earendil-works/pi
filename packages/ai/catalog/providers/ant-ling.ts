import type { Model } from "../../src/types.ts";
import { defineProvider, modelsDevModels } from "../define.ts";

/**
 * Ant Ling (listed as "bailing" on models.dev). Ling models think by default and
 * only `thinking: { type: "disabled" }` turns it off; `reasoning_effort` and
 * `reasoning.effort` are ignored. models.dev lists thinking as an on/off toggle,
 * so expose only off and high.
 */
export default defineProvider({
	id: "ant-ling",
	models: (ctx) =>
		modelsDevModels(ctx, "bailing", {
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			skipDeprecated: true,
			recordReasoning: false,
			map: (model): Model<"openai-completions"> =>
				model.reasoning
					? {
							...model,
							thinkingLevelMap: {
								off: "off",
								minimal: null,
								low: null,
								medium: null,
								high: "high",
								xhigh: null,
								max: null,
							},
						}
					: model,
		}),
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "deepseek",
			supportsStrictMode: true,
			supportsLongCacheRetention: false,
		},
	},
});
