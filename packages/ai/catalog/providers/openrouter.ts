import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { addMissing, type ChatModel, defineProvider, mergeCompat, mergeThinking } from "../define.ts";
import { enableClaudeMidConvoEffort, supportsClaudeMidConvoEffort } from "../families/anthropic.ts";
import { isKimiK3FamilyId, KIMI_K3_MAX_TOKENS } from "../families/kimi.ts";
import { OPENAI_MID_CONVO_MODEL_IDS } from "../families/openai.ts";

const BASE_URL = "https://openrouter.ai/api/v1";
// OpenRouter rejects `configuration_update` system messages on Opus 5 ("Mid-conversation
// reasoning effort (configuration_update) is not supported on anthropic/claude-opus-5-20260723")
// while accepting them on Fable 5.1.
const MID_CONVO_EFFORT_UNSUPPORTED_MODEL_IDS = new Set(["anthropic/claude-opus-5"]);

/** Keep selected model metadata stable until upstream settles. */
function correctUpstream(model: ChatModel): ChatModel {
	// Keep Kimi K3's canonical output limit when gateway metadata is missing or incorrect.
	if (
		model.id === "~moonshotai/kimi-latest" ||
		(model.id.startsWith("moonshotai/") && isKimiK3FamilyId(model.id.slice("moonshotai/".length)))
	) {
		model.maxTokens = KIMI_K3_MAX_TOKENS;
	}
	if (model.id === "moonshotai/kimi-k2.5") {
		model.cost = { ...model.cost, input: 0.41, output: 2.06, cacheRead: 0.07 };
		model.maxTokens = 4096;
	}
	if (model.id.startsWith("moonshotai/kimi-k2.6")) {
		mergeCompat(model as Model<"openai-completions">, {
			supportsDeveloperRole: false,
			requiresReasoningContentOnAssistantMessages: true,
		});
	}
	if (model.id === "z-ai/glm-5") model.cost = { ...model.cost, input: 0.6, output: 1.9, cacheRead: 0.119 };
	return model;
}

// Router aliases. Their price depends on the model they route to, so it is unknown here.
const ROUTER_MODELS: Model<"openai-completions">[] = [
	{
		id: "auto",
		name: "Auto",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 2000000,
		maxTokens: 30000,
	},
	// OpenRouter exposes Fusion as a router alias/plugin entry point; its model
	// metadata does not advertise tools, but the alias resolves to a concrete model
	// that can invoke caller tools and has the openrouter:fusion server tool auto-injected.
	{
		id: "openrouter/fusion",
		name: "OpenRouter: Fusion",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 30000,
	},
];

export default defineProvider({
	id: "openrouter",
	models: (ctx) =>
		addMissing(structuredClone(ctx.sources.openRouter.chat).map(correctUpstream), structuredClone(ROUTER_MODELS)),
	images: (ctx) => structuredClone(ctx.sources.openRouter.images),
	classifiers: (ctx) => structuredClone(ctx.sources.openRouter.classifiers),
	compat: {
		"openai-completions": (model): OpenAICompletionsCompat => ({
			// OpenRouter passes developer messages through to Anthropic and OpenAI models only.
			...(/^(anthropic|openai)\//.test(model.id) ? {} : { supportsDeveloperRole: false }),
			thinkingFormat: "openrouter",
			supportsStrictMode: true,
			...(/^~?anthropic\//.test(model.id) ? { cacheControlFormat: "anthropic" } : {}),
			sendSessionAffinityHeaders: true,
		}),
	},
	finalize: (model) => {
		if (
			model.api === "anthropic-messages" &&
			supportsClaudeMidConvoEffort(model.id) &&
			!MID_CONVO_EFFORT_UNSUPPORTED_MODEL_IDS.has(model.id)
		) {
			enableClaudeMidConvoEffort(model as Model<"anthropic-messages">);
		}
		if (model.id.startsWith("inception/mercury-2")) {
			// Mercury 2 in instant mode (reasoning_effort: "none") disables tool calling.
			// Mark "off" unsupported so the openai-completions provider omits the reasoning param
			// instead of defaulting to {reasoning:{effort:"none"}}.
			// Pi's low/medium/high pass through verbatim; OpenRouter normalizes to Mercury's vocabulary.
			mergeThinking(model, { off: null });
		}
		if (model.id === "z-ai/glm-5.2") mergeThinking(model, { xhigh: "xhigh" });
		// OpenAI models behind OpenRouter accept plain system text in place.
		if (
			model.api === "openai-completions" &&
			model.id.startsWith("openai/") &&
			OPENAI_MID_CONVO_MODEL_IDS.has(model.id.slice("openai/".length))
		) {
			mergeCompat(model as Model<"openai-completions">, { supportsMidConvoSystemMessages: true });
		}
	},
});
