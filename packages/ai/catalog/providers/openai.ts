import type { ClassifierModel, Model } from "../../src/types.ts";
import {
	addMissing,
	type ChatModel,
	defineProvider,
	mergeCompat,
	mergeThinking,
	modelsDevModels,
	withInputLimits,
} from "../define.ts";
import {
	enableOpenAiGrammarTools,
	enableOpenAiMidConvoSystemMessages,
	OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
	OPENAI_STANDARD_COSTS,
	OPENAI_TOOL_SEARCH_MODEL_IDS,
	withOpenAiLongContextPricing,
} from "../families/openai.ts";

const BASE_URL = "https://api.openai.com/v1";

// models.dev lists this alias, but it is not accepted by OpenAI APIs.
const UNSUPPORTED_MODEL_IDS = new Set(["gpt-5.6"]);

// Keep direct OpenAI requests in the short-context pricing tier by default. Users can opt into the
// larger context through model overrides, so retain long-context cost metadata on the capped models.
const SHORT_CONTEXT_CAPPED_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
]);
const LONG_CONTEXT_PRICING_MODEL_IDS = new Set([...SHORT_CONTEXT_CAPPED_MODEL_IDS, "gpt-5.4-pro", "gpt-5.5-pro"]);

const NONE_REASONING_MODEL_IDS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-sol",
	"gpt-6-luna",
]);
// OpenAI documents configuration_update for the GPT-6 family.
// https://developers.openai.com/api/docs/guides/reasoning
const MID_CONVO_EFFORT_MODEL_IDS = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"]);

// Not listed by models.dev.
const GPT_5_CHAT_LATEST: Model<"openai-responses"> = {
	id: "gpt-5-chat-latest",
	name: "GPT-5 Chat Latest",
	api: "openai-responses",
	baseUrl: BASE_URL,
	provider: "openai",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

// OpenAI Decisions API (public beta): gpt-6-luna is its only model. It bills input tokens only,
// with the same long-context multiplier as chat requests. Only API keys work: Sign in with ChatGPT
// tokens are rejected on /v1/decisions, and the Codex backend has no Decisions route.
// The endpoint rejects inputs above 922K tokens (the model's documented maximum input), but
// requests running longer than about five seconds, currently above roughly 600K input tokens,
// fail with a gateway timeout.
// https://developers.openai.com/api/docs/guides/decisions
const CLASSIFIER_MODELS: ClassifierModel<"openai-decisions">[] = [
	{
		type: "classifier",
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-decisions",
		provider: "openai",
		baseUrl: BASE_URL,
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing({ input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 922000,
	},
];

function correctUpstream(model: ChatModel): ChatModel {
	if (SHORT_CONTEXT_CAPPED_MODEL_IDS.has(model.id)) {
		model.contextWindow = OPENAI_LONG_CONTEXT_INPUT_THRESHOLD;
		model.maxTokens = 128000;
	}
	if (LONG_CONTEXT_PRICING_MODEL_IDS.has(model.id)) {
		model.cost = withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS[model.id] ?? model.cost);
	}
	// models.dev reports gpt-5-pro output as 272000 (a duplicate of the input sub-limit);
	// the actual max output is 128000. Also propagates to the derived Azure clone.
	if (model.id === "gpt-5-pro") model.maxTokens = 128000;
	return model;
}

export default defineProvider({
	id: "openai",
	models: (ctx) =>
		addMissing(
			modelsDevModels(ctx, "openai", {
				api: "openai-responses",
				baseUrl: BASE_URL,
				// Audio models are only served on Chat Completions.
				protocol: "responses",
				include: (source) => !UNSUPPORTED_MODEL_IDS.has(source.id),
				map: correctUpstream,
			}),
			[GPT_5_CHAT_LATEST],
		),
	classifiers: () => CLASSIFIER_MODELS,
	finalize: (model) => {
		if (model.api !== "openai-responses") return;
		const responsesModel = model as Model<"openai-responses">;
		if (NONE_REASONING_MODEL_IDS.has(model.id)) mergeThinking(model, { off: "none" });
		if (model.id === "gpt-5.5") mergeThinking(model, { minimal: null });
		mergeCompat(responsesModel, { supportsStrictMode: true });
		enableOpenAiGrammarTools(model);
		if (OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id)) {
			mergeCompat(responsesModel, { supportsAdditionalTools: true, supportsToolSearch: true });
		}
		enableOpenAiMidConvoSystemMessages(model, { proxy: false });
		// OpenAI charges prompt-cache writes starting with the GPT-5.6 family, and exactly
		// those models accept `prompt_cache_options`; older models reject the parameter.
		// https://developers.openai.com/api/docs/guides/prompt-caching
		if (model.cost.cacheWrite > 0) mergeCompat(responsesModel, { supportsExplicitPromptCacheMode: true });
		if (MID_CONVO_EFFORT_MODEL_IDS.has(model.id)) mergeCompat(responsesModel, { supportsMidConvoEffort: true });
		withInputLimits(model, { maxRequestBytes: 512 * 1024 * 1024, images: { maxPerRequest: 1500 } });
	},
});
