import type { Api, Model, ThinkingLevelMap } from "../../src/types.ts";
import { addMissing, type ChatModel, defineProvider, mergeCompat, mergeThinking, modelsDevModels } from "../define.ts";
import { claude55ThinkingLevels, supportsClaudeMidConvoSystemMessages } from "../families/anthropic.ts";
import {
	enableOpenAiGrammarTools,
	enableOpenAiMidConvoSystemMessages,
	openAiStandardCost,
} from "../families/openai.ts";

const BASE_URL = "https://api.individual.githubcopilot.com";
const STATIC_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

// GitHub's "Models with extended capabilities" table lists these Copilot models as supporting
// the extended 1 million token context window.
const EXTENDED_CONTEXT_MODEL_IDS = new Set([
	"claude-fable-5",
	"claude-opus-4.8",
	"claude-opus-5",
	"claude-opus-5.5",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
]);

const EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_MODEL_IDS = new Set([
	"claude-haiku-4.5",
	"claude-sonnet-4",
	"claude-sonnet-4.5",
]);

// Checked manually against the authenticated GitHub Copilot /models endpoint on 2026-06-15.
// Keep this to narrow corrections over models.dev metadata instead of snapshotting Copilot's catalog.
const THINKING_LEVEL_OVERRIDES: Record<string, ThinkingLevelMap> = {
	"claude-opus-4.8": { minimal: "low" },
	"claude-opus-5": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
};

/** Claude 4.x and 5.x use Messages; GPT, Grok, OSWE, and MAI-Code are only served on /responses. */
function copilotApi(modelId: string): Api {
	if (/^claude-(haiku|sonnet|opus|fable)-[45]([.-]|$)/.test(modelId)) return "anthropic-messages";
	if (/^(gpt-|grok-|oswe|mai-)/.test(modelId)) return "openai-responses";
	return "openai-completions";
}

// The authenticated Copilot catalog advertised these models on 2026-09-22,
// but models.dev did not include them yet.
const GPT_6_LUNA: Model<"openai-responses"> = {
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: openAiStandardCost("gpt-6-luna"),
	contextWindow: 1000000,
	maxTokens: 128000,
	headers: { ...STATIC_HEADERS },
};

export default defineProvider({
	id: "github-copilot",
	models: (ctx) =>
		addMissing(
			modelsDevModels(ctx, "github-copilot", {
				api: "openai-completions",
				baseUrl: BASE_URL,
				headers: STATIC_HEADERS,
				skipDeprecated: true,
				defaultContextWindow: 128000,
				defaultMaxTokens: 8192,
				map: (model): ChatModel => {
					const api = copilotApi(model.id);
					const result: ChatModel = { ...model, api };
					if (api === "openai-completions") {
						result.compat = {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						};
					}
					if (model.id === "claude-opus-5.5") mergeThinking(result, claude55ThinkingLevels(model.id));
					return result;
				},
			}),
			[GPT_6_LUNA],
		).map((model) => (EXTENDED_CONTEXT_MODEL_IDS.has(model.id) ? { ...model, contextWindow: 1000000 } : model)),
	compat: { "openai-completions": { supportsStrictMode: true } },
	finalize: (model) => {
		if (model.id.startsWith("gpt-5")) mergeThinking(model, { minimal: "low" });
		const override = THINKING_LEVEL_OVERRIDES[model.id];
		if (override) mergeThinking(model, override);
		if (model.api === "anthropic-messages") {
			const messagesModel = model as Model<"anthropic-messages">;
			// Copilot forwards mid-conversation system messages but rejects
			// `tool_addition`/`tool_removal` blocks, so tool changes stay top-level.
			if (supportsClaudeMidConvoSystemMessages(model.id)) {
				mergeCompat(messagesModel, { supportsMidConvoSystemMessages: true });
			}
			if (EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_MODEL_IDS.has(model.id)) {
				mergeCompat(messagesModel, { supportsEagerToolInputStreaming: false });
			}
		}
		// Copilot forwards Kimi K3's system text but silently drops its tool-bearing message.
		if (model.api === "openai-completions" && model.id === "kimi-k3") {
			mergeCompat(model as Model<"openai-completions">, { supportsMidConvoSystemMessages: true });
		}
		// Copilot passes mid-conversation developer messages and `additional_tools`
		// through to OpenAI unchanged; tool search is not verified through it.
		enableOpenAiMidConvoSystemMessages(model, { proxy: true });
		enableOpenAiGrammarTools(model);
	},
});
