import type { Api, ClassifierModel, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "../../src/types.ts";
import {
	type ChatModel,
	defineProvider,
	mergeCompat,
	mergeThinking,
	modelsDevModels,
	type ProviderContext,
} from "../define.ts";
import { supportsClaudeMidConvoSystemMessages } from "../families/anthropic.ts";
import { googleThinkingLevels } from "../families/google.ts";
import { isKimiK3FamilyId } from "../families/kimi.ts";
import { enableOpenAiGrammarTools, enableOpenAiMidConvoSystemMessages } from "../families/openai.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import type { ModelsDevModel } from "../sources/models-dev.ts";

// OpenAI-compatible endpoints reject the long prompt-cache retention parameter for these models.
const LONG_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set([
	"opencode:deepseek-v4-flash",
	"opencode:deepseek-v4.1-flash",
	"opencode:deepseek-v4-pro",
	"opencode:kimi-k2.5",
	"opencode:kimi-k2.6",
	"opencode:minimax-m2.7",
	"opencode-go:kimi-k2.6",
]);

// OpenCode serves each model on one protocol-specific endpoint. Native protocols
// come before generic Chat Completions if models.dev ever lists several.
const OPENCODE_PROTOCOLS = ["responses", "messages", "generate-content", "chat-completions"] as const;

interface OpencodeApi {
	api: Api;
	baseUrl: string;
	compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}

/**
 * The API and base URL models.dev lists for a model. Models served only on a
 * protocol pi does not support fail strict generation and are skipped otherwise.
 */
function opencodeApi(ctx: ProviderContext, source: ModelsDevModel): OpencodeApi | undefined {
	const entry = OPENCODE_PROTOCOLS.map((protocol) =>
		source.apis.find((candidate) => candidate.protocol === protocol),
	).find((candidate) => candidate !== undefined);
	if (!entry) {
		const protocols = source.apis.map((candidate) => candidate.protocol).join(", ") || "none";
		const message = `models.dev lists no supported API for ${ctx.providerId}/${source.id} (${protocols})`;
		if (ctx.strict) throw new Error(message);
		console.warn(`Skipping model: ${message}`);
		return undefined;
	}
	switch (entry.protocol) {
		case "responses":
			return {
				api: "openai-responses",
				baseUrl: entry.baseUrl,
				compat: { sessionAffinityFormat: "openai-nosession" },
			};
		case "messages":
			// The Anthropic SDK appends /v1/messages itself.
			return { api: "anthropic-messages", baseUrl: entry.baseUrl.replace(/\/v1\/?$/, "") };
		case "generate-content":
			return { api: "google-generative-ai", baseUrl: entry.baseUrl };
		case "chat-completions":
			return {
				api: "openai-completions",
				baseUrl: entry.baseUrl,
				...(entry.aisdk === "@ai-sdk/alibaba" ? { compat: { cacheControlFormat: "anthropic" } } : {}),
			};
	}
}

/** OpenCode Zen and Go models, on the endpoints models.dev lists for them. */
export function opencodeModels(ctx: ProviderContext): ChatModel[] {
	const provider = ctx.providerId;
	return modelsDevModels(ctx, provider, {
		api: "openai-completions",
		// Replaced by the base URL of the API models.dev lists for each model.
		baseUrl: "",
		skipDeprecated: true,
		// Codex Spark is not usable through OpenCode.
		include: (source) => source.id !== "gpt-5.3-codex-spark",
		map: (model, source) => {
			const served = opencodeApi(ctx, source);
			if (!served) return undefined;
			let { api, baseUrl, compat } = served;
			if (provider === "opencode" && model.id === "grok-build-0.1") {
				compat = { ...compat, supportsReasoningEffort: false };
			}
			if (model.id === "kimi-k2.6") {
				// OpenCode Kimi K2.6 accepts Anthropic-style thinking objects
				// and rejects string thinking values or combined reasoning_effort.
				compat = { ...compat, thinkingFormat: "deepseek", supportsReasoningEffort: false };
			}
			// models.dev reports these as @ai-sdk/anthropic, but OpenCode Go serves
			// them through the OpenAI-compatible /openai/v1/chat/completions path.
			if (
				provider === "opencode-go" &&
				api === "anthropic-messages" &&
				(model.id === "qwen3.5-plus" || model.id === "qwen3.6-plus")
			) {
				api = "openai-completions";
				baseUrl = baseUrl.replace(/\/anthropic$/, "/openai/v1");
				// Qwen/DashScope uses enable_thinking at the top level.
				compat = { ...compat, thinkingFormat: "qwen" };
			}
			if (api === "openai-completions") {
				compat = {
					...compat,
					maxTokensField: "max_tokens",
					...(LONG_CACHE_RETENTION_UNSUPPORTED_MODELS.has(`${provider}:${model.id}`)
						? { supportsLongCacheRetention: false }
						: {}),
				};
			}
			const thinkingLevelMap =
				api === "google-generative-ai"
					? googleThinkingLevels(model.id, source.reasoningOptions)
					: provider === "opencode-go" && model.id === "deepseek-v4.1-flash"
						? getEffortThinkingLevelMap(source.reasoningOptions ?? [])
						: undefined;
			const result: ChatModel = { ...model, api, baseUrl, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
			if (compat) result.compat = compat;
			// OpenCode variants list Claude Sonnet 4/4.5 with 1M context, actual limit is 200K.
			if (model.id === "claude-sonnet-4-5" || model.id === "claude-sonnet-4") result.contextWindow = 200000;
			if (["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4.6", "claude-sonnet-4.6"].includes(model.id)) {
				result.contextWindow = 1000000;
			}
			if (model.id === "gpt-5.4") {
				result.contextWindow = 272000;
				result.maxTokens = 128000;
			}
			return result;
		},
	});
}

export const OPENCODE_COMPLETIONS_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsStrictMode: true,
} as const;

/** Behavior shared by OpenCode Zen and Go. */
export function finalizeOpencodeModel(model: ChatModel): void {
	if (model.provider === "opencode-go" && model.id === "glm-5.2") {
		mergeThinking(model, { off: null, minimal: null, low: null, medium: null, high: "high", max: "max" });
	}
	if (model.provider === "opencode-go" && model.id === "kimi-k2.6") {
		// OpenCode Go exposes Kimi K2.6 thinking as on/off, not distinct effort tiers.
		mergeThinking(model, { minimal: null, low: null, medium: null });
	}
	if (model.provider === "opencode" && model.id === "grok-build-0.1") {
		// OpenCode Zen Grok Build reasons by default but rejects explicit reasoningEffort.
		mergeThinking(model, { off: null, minimal: null, low: null, medium: null });
	}
	if (model.api === "anthropic-messages") {
		const messagesModel = model as Model<"anthropic-messages">;
		// OpenCode Zen forwards mid-conversation system messages but rejects
		// `tool_addition`/`tool_removal` blocks, so tool changes stay top-level.
		if (model.provider === "opencode" && supportsClaudeMidConvoSystemMessages(model.id)) {
			mergeCompat(messagesModel, { supportsMidConvoSystemMessages: true });
		}
		// OpenCode Qwen 3.8 Flash emits and accepts thinking blocks with empty signatures.
		if (model.id === "qwen3.8-flash") mergeCompat(messagesModel, { allowEmptySignature: true });
	}
	// The Kimi K3 family accepts tool-bearing system messages; OpenCode passes them through.
	if (model.api === "openai-completions" && isKimiK3FamilyId(model.id)) {
		mergeCompat(model as Model<"openai-completions">, {
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolAdditions: true,
		});
	}
	// OpenCode passes mid-conversation developer messages and `additional_tools`
	// through to OpenAI unchanged; tool search is not verified through it.
	enableOpenAiMidConvoSystemMessages(model, { proxy: true });
}

// OpenCode Zen serves Jev through its TypeSafe-compatible System One endpoint.
// Neither its /inference/openai/v1/models listing nor models.dev carries metadata for it.
// https://opencode.ai/docs/zen
function jev(id: string, name: string, input: number): ClassifierModel<"typesafe-system-one"> {
	return {
		type: "classifier",
		id,
		name,
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: "https://opencode.ai/inference/systemone/v1",
		input: ["text"],
		cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	};
}

export default defineProvider({
	id: "opencode",
	models: opencodeModels,
	classifiers: () => [jev("jev-1.13", "Jev 1.13", 0.042), jev("jev-1.13-free", "Jev 1.13 Free", 0)],
	compat: { "openai-completions": OPENCODE_COMPLETIONS_COMPAT },
	finalize: (model) => {
		finalizeOpencodeModel(model);
		enableOpenAiGrammarTools(model);
	},
});
