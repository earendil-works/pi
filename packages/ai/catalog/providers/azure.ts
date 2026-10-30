import type { Model, ModelCost } from "../../src/types.ts";
import { type ChatModel, defineProvider, mergeCompat } from "../define.ts";
import { enableOpenAiGrammarTools } from "../families/openai.ts";

// Azure Foundry deploys these with larger context windows than OpenAI's own short-tier defaults.
// See models-sold-directly-by-azure docs.
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
	"gpt-5.4": 1050000,
	"gpt-5.5": 1050000,
	"gpt-5.6-luna": 1050000,
	"gpt-5.6-sol": 1050000,
	"gpt-5.6-terra": 1050000,
};

// Azure resells DeepSeek at its own rates. US data zone, checked 2026-09-16.
// https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/deepseek/
const DEEPSEEK_V4_PRO_COST: ModelCost = { input: 1.925, output: 3.828, cacheRead: 0.165, cacheWrite: 0 };

/** OpenAI models as Azure deploys them. Azure bills without OpenAI's long-context tier. */
function openAiModels(models: ChatModel[]): ChatModel[] {
	return models
		.filter((model) => model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "",
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.contextWindow,
		}));
}

export default defineProvider({
	id: "azure",
	models: (ctx) => [
		...openAiModels(ctx.providerModels("openai")),
		...ctx
			.providerModels("deepseek")
			.filter((model) => model.id === "deepseek-v4-pro")
			.map((model) => ({ ...model, provider: "azure", baseUrl: "", cost: DEEPSEEK_V4_PRO_COST })),
	],
	compat: { "openai-completions": { supportsStrictMode: true } },
	finalize: (model) => {
		enableOpenAiGrammarTools(model);
		if (model.api === "openai-completions") {
			// Azure 400s on DeepSeek's `thinking` field and on every prompt cache parameter, discards a
			// `developer` system message unbilled once reasoning_effort is set, and honours mid-convo ones (#9645).
			mergeCompat(model as Model<"openai-completions">, {
				supportsDeveloperRole: false,
				supportsMidConvoSystemMessages: true,
				thinkingFormat: "openai",
				supportsLongCacheRetention: false,
			});
		}
	},
});
