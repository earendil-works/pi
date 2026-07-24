#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../src/api/cloudflare.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	KnownProvider,
	Model,
	ModelCost,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../src/types.ts";
import {
	createModelDataManifest,
	type ModelDataStructure,
	MODEL_DATA_MANIFEST_FILE,
	readModelDataProviderIds,
	validateGeneratedModelData,
	validateModelDataDirectory,
} from "./model-data.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

function readGeneratorOptions(args: string[]): {
	strict: boolean;
	dataOnly: boolean;
	jsonOnly: boolean;
	jsonOutputDir: string | undefined;
	pretty: boolean;
} {
	let strict = false;
	let dataOnly = false;
	let jsonOnly = false;
	let jsonOutputDir: string | undefined;
	let pretty = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") {
			strict = true;
			continue;
		}
		if (arg === "--data-only") {
			dataOnly = true;
			continue;
		}
		if (arg === "--json-only") {
			jsonOnly = true;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			jsonOutputDir = resolve(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (jsonOnly && !jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (dataOnly && (jsonOnly || jsonOutputDir)) throw new Error("--data-only cannot be combined with JSON catalog output");
	return { strict, dataOnly, jsonOnly, jsonOutputDir, pretty };
}

const generatorOptions = readGeneratorOptions(process.argv.slice(2));

interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	structured_output?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: {
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
			tier?: {
				type?: string;
				size?: number;
			};
		}[];
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

interface NvidiaNimModelListItem {
	id: string;
}

interface AiGatewayModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: {
		input?: string | number;
		output?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
}

const COPILOT_STATIC_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

const KIMI_STATIC_HEADERS = {
	"User-Agent": "KimiCLI/1.5",
} as const;

const TOGETHER_BASE_URL = "https://api.together.ai/v1";
const TOGETHER_BASE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const TOGETHER_TOGGLE_REASONING_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	thinkingFormat: "together",
};
const TOGETHER_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	supportsReasoningEffort: true,
	thinkingFormat: "openai",
};
const TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_TOGGLE_REASONING_COMPAT,
	supportsReasoningEffort: true,
};
const TOGETHER_REASONING_ONLY_MODELS = new Set([
	"deepseek-ai/DeepSeek-R1",
	"MiniMaxAI/MiniMax-M2.7",
]);
const TOGETHER_REASONING_EFFORT_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
const TOGETHER_TOGGLE_REASONING_EFFORT_MODELS = new Set(["deepseek-ai/DeepSeek-V4-Pro"]);
const TOGETHER_FIXED_REASONING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
} as const;
const TOGETHER_REASONING_EFFORT_LEVEL_MAP = {
	off: null,
	minimal: null,
} as const;
const TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
} as const;
const TOGETHER_TOGGLE_REASONING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
} as const;

const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_HEADERS = {
	"NVCF-POLL-SECONDS": "3600",
} as const;
const NVIDIA_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const NVIDIA_NIM_UNSUPPORTED_MODELS = new Set([
	"abacusai/dracarys-llama-3.1-70b-instruct",
	"bytedance/seed-oss-36b-instruct",
	"deepseek-ai/deepseek-v4-flash",
	"deepseek-ai/deepseek-v4-pro",
	"google/gemma-2-2b-it",
	"google/gemma-3n-e2b-it",
	"google/gemma-3n-e4b-it",
	"google/gemma-4-31b-it",
	"meta/llama-3.2-1b-instruct",
	"meta/llama-4-maverick-17b-128e-instruct",
	"microsoft/phi-4-mini-instruct",
	"minimaxai/minimax-m2.7",
	"mistralai/mistral-nemotron",
	"nvidia/nemotron-mini-4b-instruct",
	"qwen/qwen3-next-80b-a3b-instruct",
	"qwen/qwen3.5-397b-a17b",
	"sarvamai/sarvam-m",
	"upstage/solar-10.7b-instruct",
]);
const ZAI_TOOL_STREAM_UNSUPPORTED_MODELS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);
const ZAI_GLM52_THINKING_LEVEL_MAP = {
	minimal: null,
	low: "high",
	medium: "high",
	high: "high",
	max: "max",
} as const;
const OPENCODE_GO_GLM52_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
const EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS = new Set([
	"github-copilot:claude-haiku-4.5",
	"github-copilot:claude-sonnet-4",
	"github-copilot:claude-sonnet-4.5",
]);

const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;

const KIMI_K3_MAX_TOKENS = 131072;
const KIMI_K3_COST = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 0,
} as const;
// Kimi Coding is subscription-backed, so models.dev reports zero cost. Use the
// equivalent Moonshot API rates to estimate the value of subscription usage.
const KIMI_CODING_IMPLIED_COSTS: Record<string, Model<Api>["cost"]> = {
	k3: KIMI_K3_COST,
	"kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	"kimi-k2-thinking": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
};
const OPENROUTER_KIMI_K3_MODEL_IDS = new Set(["moonshotai/kimi-k3", "~moonshotai/kimi-latest"]);

const ANT_LING_RING_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "xhigh",
} as const;

const MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS = new Set(["gpt-5.6"]);
const OPENAI_TOOL_SEARCH_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272000;
const OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);
const OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

function withOpenAiLongContextPricing(cost: Model<Api>["cost"]): Model<Api>["cost"] {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: cost.input * 2,
				output: cost.output * 1.5,
				cacheRead: cost.cacheRead * 2,
				cacheWrite: cost.cacheWrite * 2,
			},
		],
	};
}

const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
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
]);
const XAI_RESPONSES_MODEL_ID = "grok-4.5";
const XAI_BUILTIN_EXCLUDED_MODEL_IDS = new Set([
	"grok-3",
	"grok-3-fast",
	"grok-4.20-0309-non-reasoning",
	"grok-4.20-0309-reasoning",
	"grok-code-fast-1",
]);
const XAI_RESPONSES_EFFORT_LEVEL_MAP = {
	off: null,
	minimal: null,
} as const;
const XAI_RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsLongCacheRetention: false,
};

const OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set([
	"opencode:deepseek-v4-flash",
	"opencode:deepseek-v4-pro",
	"opencode:kimi-k2.5",
	"opencode:kimi-k2.6",
	"opencode:minimax-m2.7",
	"opencode-go:kimi-k2.6",
]);

// GitHub's "Models with extended capabilities" table lists these Copilot models as supporting
// the extended 1 million token context window.
const GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS = new Set([
	"claude-fable-5",
	"claude-opus-4.6",
	"claude-opus-4.7",
	"claude-opus-4.8",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.5",
]);

// Checked manually against the authenticated GitHub Copilot /models endpoint on 2026-06-15.
// Keep this to narrow corrections over models.dev metadata instead of snapshotting Copilot's catalog.
const GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES = {
	"claude-opus-4.7": { minimal: "low" },
	"claude-opus-4.8": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
} satisfies Record<string, NonNullable<Model<Api>["thinkingLevelMap"]>>;

function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

const modelsDevReasoningOptions = new Map<string, ModelsDevReasoningOption[]>();

function getModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}:${model.id}`;
}

function recordModelsDevReasoningOptions(provider: string, id: string, sourceModel: ModelsDevModel): void {
	if (sourceModel.reasoning_options !== undefined) {
		modelsDevReasoningOptions.set(`${provider}:${id}`, sourceModel.reasoning_options);
	}
}

function supportsDirectReasoningEffort(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages") return model.compat?.forceAdaptiveThinking === true;
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		return true;
	}
	if (model.api !== "openai-completions") return false;

	const compat = {
		...detectOpenAICompletionsCompat(model as Model<"openai-completions">),
		...(model.compat as OpenAICompletionsCompat | undefined),
	};
	return compat.thinkingFormat === "openai" && compat.supportsReasoningEffort;
}

function applyModelsDevReasoningOptionMetadata(model: Model<Api>): void {
	const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
	if (!reasoningOptions || !supportsDirectReasoningEffort(model)) return;
	const thinkingLevelMap = getEffortThinkingLevelMap(reasoningOptions);
	if (thinkingLevelMap) mergeThinkingLevelMap(model, thinkingLevelMap);
}

function getTogetherCompat(modelId: string, reasoning: boolean): OpenAICompletionsCompat {
	if (!reasoning) return TOGETHER_BASE_COMPAT;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_REASONING_EFFORT_COMPAT;
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT;
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return TOGETHER_BASE_COMPAT;
	return TOGETHER_TOGGLE_REASONING_COMPAT;
}

function getTogetherThinkingLevelMap(
	modelId: string,
	reasoning: boolean,
): NonNullable<Model<any>["thinkingLevelMap"]> | undefined {
	if (!reasoning) return undefined;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_REASONING_EFFORT_LEVEL_MAP };
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP };
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return { ...TOGETHER_FIXED_REASONING_LEVEL_MAP };
	return { ...TOGETHER_TOGGLE_REASONING_LEVEL_MAP };
}

function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6")
	);
}

function supportsOpenAiMax(model: Model<Api>): boolean {
	return (
		model.id.includes("gpt-5.6") &&
		(model.api === "openai-responses" ||
			model.api === "azure-openai-responses" ||
			model.api === "openai-codex-responses" ||
			model.api === "openai-completions")
	);
}

function isGoogleThinkingApi(model: Model<any>): boolean {
	return model.api === "google-generative-ai" || model.api === "google-vertex";
}

function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("opus-4-8") ||
		modelId.includes("opus-4.8") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6") ||
		modelId.includes("sonnet-5") ||
		modelId.includes("sonnet.5") ||
		modelId.includes("fable-5")
	);
}

function isAnthropicTemperatureUnsupportedModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return id.includes("opus-4-7") || id.includes("opus-4.7") || id.includes("opus-4-8") || id.includes("opus-4.8");
}

const OPENAI_COMPLETIONS_DEFAULT_COMPAT = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat" | "deferredToolsMode">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
};

type OpenAICompletionsResolvedCompat = typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function mergeAnthropicMessagesCompat(model: Model<Api>, compat: AnthropicMessagesCompat): void {
	model.compat = { ...(model.compat as AnthropicMessagesCompat | undefined), ...compat };
}

function detectOpenAICompletionsCompat(model: Model<"openai-completions">): OpenAICompletionsResolvedCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isTogetherReasoningOnly = isTogether && TOGETHER_REASONING_ONLY_MODELS.has(model.id);

	const isNonStandard =
		isNvidia ||
		provider === "cerebras" ||
		baseUrl.includes("cerebras.ai") ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("deepseek.com") ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") || isMoonshot || isCloudflareAiGateway || isTogether || isNvidia || isAntLing;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat =
		provider === "openrouter" && /^~?anthropic\//.test(model.id) ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether && !isTogetherReasoningOnly
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		zaiToolStream: false,
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
		supportsOpenAIGrammarTools: false,
		...(cacheControlFormat ? { cacheControlFormat } : {}),
		sendSessionAffinityHeaders: false,
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

function isPlainEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function openAICompletionsCompatDelta(compat: OpenAICompletionsResolvedCompat): OpenAICompletionsCompat {
	const delta: OpenAICompletionsCompat = {};
	for (const [key, value] of Object.entries(compat)) {
		const defaultValue = OPENAI_COMPLETIONS_DEFAULT_COMPAT[key as keyof typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT];
		if (isPlainEmptyObject(value) && isPlainEmptyObject(defaultValue)) continue;
		if (value !== defaultValue) {
			(delta as Record<string, unknown>)[key] = value;
		}
	}
	return delta;
}

function mergeOpenAICompletionsCompat(model: Model<Api>, compat: OpenAICompletionsCompat): void {
	model.compat = { ...(model.compat as OpenAICompletionsCompat | undefined), ...compat };
}

function applyOpenAICompletionsCompatMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const detected = openAICompletionsCompatDelta(detectOpenAICompletionsCompat(model as Model<"openai-completions">));
	model.compat = { ...detected, ...(model.compat as OpenAICompletionsCompat | undefined) };
	if (Object.keys(model.compat).length === 0) {
		delete model.compat;
	}
}

function applyStrictToolCompatMetadata(model: Model<Api>): void {
	if (model.provider === "openai" && model.api === "openai-responses") {
		model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsStrictMode: true };
	} else if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		mergeAnthropicMessagesCompat(model, { supportsStrictTools: true });
	}
}

// Responses endpoints verified (OpenAI, ChatGPT Codex backend, GitHub Copilot,
// opencode zen) or documented (Azure OpenAI, Cloudflare AI Gateway) to pass
// OpenAI custom grammar tools through. OpenAI rejects `type: "custom"` tools
// for pre-GPT-5 models (gpt-4.x, gpt-4o, o-series).
const OPENAI_GRAMMAR_TOOL_PROVIDERS = new Set([
	"openai",
	"openai-codex",
	"azure-openai-responses",
	"github-copilot",
	"opencode",
	"cloudflare-ai-gateway",
]);
const OPENAI_GRAMMAR_TOOL_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

function applyOpenAIGrammarToolCompatMetadata(model: Model<Api>): void {
	if (!OPENAI_GRAMMAR_TOOL_APIS.has(model.api) || !OPENAI_GRAMMAR_TOOL_PROVIDERS.has(model.provider)) return;
	const match = /^gpt-(\d+)/.exec(model.id);
	if (!match || Number(match[1]) < 5) return;
	model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsOpenAIGrammarTools: true };
}

function applyOpenAIToolSearchMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isOpenAICodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (!(isOpenAIResponses || isOpenAICodex) || !OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id)) return;
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsToolSearch: true,
	};
}

// OpenAI charges prompt-cache writes starting with the GPT-5.6 family, and exactly
// those models accept `prompt_cache_options`; older models reject the parameter.
// https://developers.openai.com/api/docs/guides/prompt-caching
function applyOpenAIExplicitPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider !== "openai" || model.api !== "openai-responses") return;
	if (!(model.cost.cacheWrite > 0)) return;
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsExplicitPromptCacheMode: true,
	};
}

function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

function applyThinkingLevelMetadata(model: Model<any>): void {
	if (
		(model.api === "openai-responses" || model.api === "azure-openai-responses") &&
		model.id.startsWith("gpt-5")
	) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "github-copilot" && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	if (model.provider === "xai" && model.api === "openai-responses" && model.id === XAI_RESPONSES_MODEL_ID) {
		mergeThinkingLevelMap(model, XAI_RESPONSES_EFFORT_LEVEL_MAP);
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (supportsOpenAiMax(model)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (model.provider === "openai" && model.id === "gpt-5.5") {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	if (model.id.endsWith("gpt-5.5-pro")) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null });
	}
	// Anthropic adaptive-thinking effort support (per Anthropic adaptive thinking docs):
	// - "max" is available on all adaptive-thinking Claude models.
	// - "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("sonnet-4-6") ||
		model.id.includes("sonnet-4.6")
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("sonnet.5")
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (model.id.includes("fable-5")) {
		mergeThinkingLevelMap(model, { off: null, xhigh: "xhigh", max: "max" });
	}
	if (model.api === "anthropic-messages" && isAnthropicAdaptiveThinkingModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { forceAdaptiveThinking: true });
	}
	if (model.api === "anthropic-messages" && isAnthropicTemperatureUnsupportedModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { supportsTemperature: false });
	}
	if (model.api === "openai-completions" && model.id.includes("deepseek-v4")) {
		mergeThinkingLevelMap(
			model,
			model.provider === "openrouter"
				? { ...DEEPSEEK_V4_THINKING_LEVEL_MAP, xhigh: "xhigh", max: null }
				: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		);
	}
	if (isGoogleThinkingApi(model) && isGemini3ProModel(model.id)) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" });
	}
	if (isGoogleThinkingApi(model) && isGemini3FlashModel(model.id)) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (isGoogleThinkingApi(model) && isGemma4Model(model.id)) {
		mergeThinkingLevelMap(model, { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" });
	}
	if (model.provider === "groq" && model.id === "qwen/qwen3-32b") {
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null, high: "default" });
	}
	if (model.provider === "openai-codex" && supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		(model.provider === "moonshotai" || model.provider === "moonshotai-cn") &&
		(model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed")
	) {
		// Kimi K2.7 Code is always-thinking. Official docs say
		// `thinking: { type: "disabled" }` is rejected, and callers can omit
		// the thinking parameter to use the enabled default.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id.startsWith("inception/mercury-2")) {
		// Mercury 2 in instant mode (reasoning_effort: "none") disables tool calling.
		// Mark "off" unsupported so the openai-completions provider omits the reasoning param
		// instead of defaulting to {reasoning:{effort:"none"}} (see openai-completions.ts:575).
		// Pi's low/medium/high pass through verbatim; OpenRouter normalizes to Mercury's vocabulary.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id === "z-ai/glm-5.2") {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.provider === "fireworks" && model.id.includes("glm-5p2")) {
		mergeThinkingLevelMap(model, { off: "none", minimal: null, low: "high", medium: "high", max: "max" });
	}
	if (model.provider === "opencode-go" && model.id === "glm-5.2") {
		mergeThinkingLevelMap(model, OPENCODE_GO_GLM52_THINKING_LEVEL_MAP);
	}
	if (model.provider === "opencode-go" && model.id === "kimi-k2.6") {
		// OpenCode Go exposes Kimi K2.6 thinking as on/off, not distinct effort tiers.
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null });
	}
	if (model.provider === "opencode" && model.id === "grok-build-0.1") {
		// OpenCode Zen Grok Build reasons by default but rejects explicit reasoningEffort.
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null, medium: null });
	}
	if (model.provider === "ant-ling" && model.reasoning) {
		// Ring reasons by default. Only high/xhigh have documented explicit effort controls.
		mergeThinkingLevelMap(model, ANT_LING_RING_THINKING_LEVEL_MAP);
	}
	if (model.provider === "github-copilot") {
		const override = GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES[model.id];
		if (override) {
			mergeThinkingLevelMap(model, override);
		}
	}
}

function getAnthropicMessagesCompat(provider: string, modelId: string): AnthropicMessagesCompat | undefined {
	const compat: AnthropicMessagesCompat = {};
	if (EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)) {
		compat.supportsEagerToolInputStreaming = false;
	}
	if (provider === "xiaomi" || provider.startsWith("xiaomi-token-plan-")) {
		compat.allowEmptySignature = true;
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

function getBedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function getModelsDevCost(cost: ModelsDevModel["cost"]): ModelCost {
	const tiers = cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input || 0,
				output: tier.output || 0,
				cacheRead: tier.cache_read || 0,
				cacheWrite: tier.cache_write || 0,
			},
		];
	});

	return {
		input: cost?.input || 0,
		output: cost?.output || 0,
		cacheRead: cost?.cache_read || 0,
		cacheWrite: cost?.cache_write || 0,
		...(tiers && tiers.length > 0 ? { tiers } : {}),
	};
}

async function fetchNvidiaNimModelIds(): Promise<Map<string, string>> {
	try {
		console.log("Fetching models from NVIDIA NIM API...");
		const response = await fetch(`${NVIDIA_BASE_URL}/models`);
		if (!response.ok) throw new Error(`NVIDIA NIM API returned ${response.status}`);
		const data = (await response.json()) as { data?: NvidiaNimModelListItem[] };
		const modelIds = new Map<string, string>();

		for (const model of data.data ?? []) {
			modelIds.set(model.id, model.id);
			modelIds.set(normalizeNvidiaModelId(model.id), model.id);
		}

		console.log(`Fetched ${data.data?.length ?? 0} model IDs from NVIDIA NIM`);
		return modelIds;
	} catch (error) {
		console.error("Failed to fetch NVIDIA NIM models:", error);
		if (generatorOptions.strict) throw error;
		return new Map();
	}
}

async function fetchOpenRouterModels(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from OpenRouter API...");
		const response = await fetch("https://openrouter.ai/api/v1/models");
		if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
		const data = await response.json();

		const models: Model<any>[] = [];

		for (const model of data.data) {
			// Only include models that support tools
			if (!model.supported_parameters?.includes("tools")) continue;

			// Parse provider from model ID
			let provider: KnownProvider = "openrouter";
			let modelKey = model.id;

			modelKey = model.id; // Keep full ID for OpenRouter

			// Parse input modalities
			const input: ("text" | "image")[] = ["text"];
			if (model.architecture?.modality?.includes("image")) {
				input.push("image");
			}

			// Convert pricing from $/token to $/million tokens
			const inputCost = roundCost(parseFloat(model.pricing?.prompt || "0") * 1_000_000);
			const outputCost = roundCost(parseFloat(model.pricing?.completion || "0") * 1_000_000);
			const cacheReadCost = roundCost(parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000);
			const cacheWriteCost = roundCost(parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000);

			const contextWindow = model.top_provider?.context_length || model.context_length || 4096;

			const normalizedModel: Model<any> = {
				id: modelKey,
				name: model.name,
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				provider,
				reasoning: model.supported_parameters?.includes("reasoning") || false,
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow,
				maxTokens: model.top_provider?.max_completion_tokens || 4096,
			};
			models.push(normalizedModel);
		}

		console.log(`Fetched ${models.length} tool-capable models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

async function fetchAiGatewayModels(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetch(`${AI_GATEWAY_MODELS_URL}/models`);
		if (!response.ok) throw new Error(`Vercel AI Gateway API returned ${response.status}`);
		const data = await response.json();
		const models: Model<any>[] = [];

		const toNumber = (value: string | number | undefined): number => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : 0;
			}
			const parsed = parseFloat(value ?? "0");
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// Only include models that support tools
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			const inputCost = roundCost(toNumber(model.pricing?.input) * 1_000_000);
			const outputCost = roundCost(toNumber(model.pricing?.output) * 1_000_000);
			const cacheReadCost = roundCost(toNumber(model.pricing?.input_cache_read) * 1_000_000);
			const cacheWriteCost = roundCost(toNumber(model.pricing?.input_cache_write) * 1_000_000);

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				reasoning: tags.includes("reasoning"),
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(`Fetched ${models.length} tool-capable models from Vercel AI Gateway`);
		return models;
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
		const data = (await response.json()) as ModelsDevCatalog;

		const models: Model<any>[] = [];
		const nvidiaNimModelIds = data.nvidia?.models ? await fetchNvidiaNimModelIds() : new Map<string, string>();

		// Process Amazon Bedrock models
		if (data["amazon-bedrock"]?.models) {
			for (const [modelId, model] of Object.entries(data["amazon-bedrock"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				let id = modelId;

				if (id.startsWith("ai21.jamba")) {
					// These models doesn't support tool use in streaming mode
					continue;
				}

				if (id.startsWith("mistral.mistral-7b-instruct-v0")) {
					// These models doesn't support system messages
					continue;
				}

				models.push({
					id,
					name: m.name || id,
					api: "bedrock-converse-stream" as const,
					provider: "amazon-bedrock" as const,
					baseUrl: getBedrockBaseUrl(id),
					reasoning: m.reasoning === true,
					input: (m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(m.structured_output === true && { compat: { supportsStrictMode: true } }),
				});
				recordModelsDevReasoningOptions("amazon-bedrock" as const, id, m);
			}
		}

		// Process Anthropic models
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("anthropic", modelId, m);
			}
		}

		// Process Google models
		if (data.google?.models) {
			for (const [modelId, model] of Object.entries(data.google.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				let source = m;
				if (modelId === "gemini-flash-latest") {
					source = (data.google.models["gemini-3.5-flash"] as ModelsDevModel | undefined) ?? m;
				}
				if (modelId === "gemini-flash-lite-latest") {
					source = (data.google.models["gemini-3.1-flash-lite"] as ModelsDevModel | undefined) ?? m;
				}

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "google-generative-ai",
					provider: "google",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					reasoning: source.reasoning === true,
					input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: source.cost?.input || 0,
						output: source.cost?.output || 0,
						cacheRead: source.cost?.cache_read || 0,
						cacheWrite: source.cost?.cache_write || 0,
					},
					contextWindow: source.limit?.context || 4096,
					maxTokens: source.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("google", modelId, source);
			}
		}

		// Process Google Vertex Gemini models. The google-vertex models.dev catalog also includes
		// Claude, OpenAI, and other MaaS models that do not use the @google/genai Gemini streaming
		// path implemented by our google-vertex provider.
		if (data["google-vertex"]?.models) {
			for (const [modelId, model] of Object.entries(data["google-vertex"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (!modelId.startsWith("gemini-")) continue;
				if (modelId === "gemini-3.1-flash-lite-preview") continue;
				let source = m;
				if (modelId === "gemini-flash-latest") {
					source = (data["google-vertex"].models["gemini-3.5-flash"] as ModelsDevModel | undefined) ?? m;
				}
				if (modelId === "gemini-flash-lite-latest") {
					source = (data["google-vertex"].models["gemini-3.1-flash-lite"] as ModelsDevModel | undefined) ?? m;
				}

				// models.dev reports Vertex cache_read/cache_write values for Gemini 2.5 Flash that
				// do not match the official Gemini API standard pricing table. pi only accounts
				// cachedContentTokenCount as cacheRead.
				const cacheRead = modelId === "gemini-2.5-flash" ? 0.03 : source.cost?.cache_read || 0;
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "google-vertex",
					provider: "google-vertex",
					baseUrl: VERTEX_BASE_URL,
					reasoning: source.reasoning === true,
					input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: source.cost?.input || 0,
						output: source.cost?.output || 0,
						cacheRead,
						cacheWrite: 0,
					},
					contextWindow: source.limit?.context || 4096,
					maxTokens: source.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("google-vertex", modelId, source);
			}
		}

		// Process OpenAI models
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev lists this alias, but it is not accepted by OpenAI APIs.
				if (MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS.has(modelId)) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("openai", modelId, m);
			}
		}

		// Process Groq models
		if (data.groq?.models) {
			for (const [modelId, model] of Object.entries(data.groq.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "groq",
					baseUrl: "https://api.groq.com/openai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("groq", modelId, m);
			}
		}

		// Process Cerebras models
		if (data.cerebras?.models) {
			for (const [modelId, model] of Object.entries(data.cerebras.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl: "https://api.cerebras.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("cerebras", modelId, m);
			}
		}

		// Process Cloudflare Workers AI models
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cloudflare-workers-ai",
					baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
				recordModelsDevReasoningOptions("cloudflare-workers-ai", modelId, m);
			}
		}

		// Process Cloudflare AI Gateway models
		if (data["cloudflare-ai-gateway"]?.models) {
			for (const [prefixedId, model] of Object.entries(data["cloudflare-ai-gateway"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const slashIdx = prefixedId.indexOf("/");
				if (slashIdx === -1) continue;
				const upstream = prefixedId.slice(0, slashIdx);
				const nativeId = prefixedId.slice(slashIdx + 1);

				let api: "anthropic-messages" | "openai-completions" | "openai-responses";
				let baseUrl: string;
				let id: string;
				if (upstream === "openai") {
					api = "openai-responses";
					baseUrl = CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL;
					id = nativeId;
				} else if (upstream === "anthropic") {
					api = "anthropic-messages";
					baseUrl = CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL;
					id = nativeId;
				} else if (upstream === "workers-ai") {
					api = "openai-completions";
					baseUrl = CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL;
					id = prefixedId;
				} else {
					continue;
				}

				// Gateway passthroughs forward session affinity headers to upstreams that
				// use them for cache/routing affinity.
				const compat =
					upstream === "anthropic" || upstream === "workers-ai" ? { sendSessionAffinityHeaders: true } : undefined;

				models.push({
					id,
					name: m.name || id,
					api,
					provider: "cloudflare-ai-gateway",
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(compat ? { compat } : {}),
				});
				recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
			}
		}

		// Process xAi models
		if (data.xai?.models) {
			for (const [modelId, model] of Object.entries(data.xai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				const useResponsesApi = modelId === XAI_RESPONSES_MODEL_ID;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: useResponsesApi ? "openai-responses" : "openai-completions",
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					...(useResponsesApi ? { compat: { ...XAI_RESPONSES_COMPAT } } : {}),
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("xai", modelId, m);
			}
		}

		// Process zAi models
		const zaiCodingPlanVariants = [
			{ provider: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
			{ provider: "zai-coding-cn", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
		] as const;

		if (data["zai-coding-plan"]?.models) {
			for (const { provider, baseUrl } of zaiCodingPlanVariants) {
				for (const [modelId, model] of Object.entries(data["zai-coding-plan"].models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;
					const supportsImage = m.modalities?.input?.includes("image");

					const isGlm52 = modelId === "glm-5.2";

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "openai-completions",
						provider,
						baseUrl,
						reasoning: m.reasoning === true,
						...(isGlm52 ? { thinkingLevelMap: ZAI_GLM52_THINKING_LEVEL_MAP } : {}),
						input: supportsImage ? ["text", "image"] : ["text"],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						compat: {
							supportsDeveloperRole: false,
							thinkingFormat: "zai",
							...(isGlm52 ? { supportsReasoningEffort: true } : {}),
							...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
					recordModelsDevReasoningOptions(provider, modelId, m);
				}
			}
		}

		// Process Mistral models
		if (data.mistral?.models) {
			for (const [modelId, model] of Object.entries(data.mistral.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "mistral-conversations",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read ?? (m.cost?.input ? roundCost(m.cost.input * 0.1) : 0),
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("mistral", modelId, m);
			}
		}

		// Process Hugging Face models
		if (data.huggingface?.models) {
			for (const [modelId, model] of Object.entries(data.huggingface.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "huggingface",
					baseUrl: "https://router.huggingface.co/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: {
						supportsDeveloperRole: false,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("huggingface", modelId, m);
			}
		}

		// Process Fireworks models
		if (data["fireworks-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["fireworks-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "fireworks",
					// Fireworks Anthropic-compatible API - SDK appends /v1/messages
					baseUrl: "https://api.fireworks.ai/inference",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					// Fireworks prompt caching uses automatic prefix matching + session affinity.
					// x-session-affinity routes requests to the same replica for cache hits.
					// cache_control on tools and eager_input_streaming are not supported.
					// See: https://docs.fireworks.ai/tools-sdks/anthropic-compatibility
					compat: {
						sendSessionAffinityHeaders: true,
						supportsEagerToolInputStreaming: false,
						supportsCacheControlOnTools: false,
						supportsLongCacheRetention: false,
					},
				});
				recordModelsDevReasoningOptions("fireworks", modelId, m);
			}
		}

		// Process NVIDIA NIM models
		if (data.nvidia?.models) {
			for (const [modelId, model] of Object.entries(data.nvidia.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (!m.modalities?.input?.includes("text")) continue;
				if (!m.modalities?.output?.includes("text")) continue;

				const liveModelId = nvidiaNimModelIds.get(modelId) ?? nvidiaNimModelIds.get(normalizeNvidiaModelId(modelId));
				if (!liveModelId) continue;
				if (NVIDIA_NIM_UNSUPPORTED_MODELS.has(liveModelId)) continue;

				models.push({
					id: liveModelId,
					name: m.name || liveModelId,
					api: "openai-completions",
					provider: "nvidia",
					baseUrl: NVIDIA_BASE_URL,
					headers: { ...NVIDIA_HEADERS },
					reasoning: m.reasoning === true,
					input: m.modalities.input.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: NVIDIA_OPENAI_COMPAT,
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("nvidia", liveModelId, m);
			}
		}

		// Process Together AI models
		const togetherProvider = data.together ?? data.togetherai ?? data["together-ai"];
		if (togetherProvider?.models) {
			for (const [modelId, model] of Object.entries(togetherProvider.models)) {
				const m = model as ModelsDevModel & { status?: string };
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const reasoning = m.reasoning === true;
				const thinkingLevelMap = getTogetherThinkingLevelMap(modelId, reasoning);
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "together",
					baseUrl: TOGETHER_BASE_URL,
					reasoning,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: getTogetherCompat(modelId, reasoning),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("together", modelId, m);
			}
		}

		// Process OpenCode models (Zen and Go)
		// API mapping based on provider.npm field:
		// - @ai-sdk/openai → openai-responses
		// - @ai-sdk/anthropic → anthropic-messages
		// - @ai-sdk/google → google-generative-ai
		// - null/undefined/@ai-sdk/openai-compatible → openai-completions
		const opencodeVariants = [
			{ key: "opencode", provider: "opencode", basePath: "https://opencode.ai/zen" },
			{ key: "opencode-go", provider: "opencode-go", basePath: "https://opencode.ai/zen/go" },
		] as const;

		for (const variant of opencodeVariants) {
			if (!data[variant.key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[variant.key].models)) {
				const m = model as ModelsDevModel & { status?: string };
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const npm = m.provider?.npm;
				let api: Api;
				let baseUrl: string;
				let compat: OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;

				if (npm === "@ai-sdk/openai") {
					api = "openai-responses";
					baseUrl = `${variant.basePath}/v1`;
					compat = { sessionAffinityFormat: "openai-nosession" };
				} else if (npm === "@ai-sdk/anthropic") {
					api = "anthropic-messages";
					// Anthropic SDK appends /v1/messages to baseURL
					baseUrl = variant.basePath;
				} else if (npm === "@ai-sdk/google") {
					api = "google-generative-ai";
					baseUrl = `${variant.basePath}/v1`;
				} else if (npm === "@ai-sdk/alibaba") {
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
					compat = { cacheControlFormat: "anthropic" };
				} else {
					// null, undefined, or @ai-sdk/openai-compatible
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
				}

				if (variant.provider === "opencode" && modelId === "grok-build-0.1") {
					compat = { ...(compat ?? {}), supportsReasoningEffort: false };
				}

				if ((variant.provider === "opencode" || variant.provider === "opencode-go") && modelId === "kimi-k2.6") {
					// OpenCode Kimi K2.6 accepts Anthropic-style thinking objects
					// and rejects string thinking values or combined reasoning_effort.
					compat = { ...(compat ?? {}), thinkingFormat: "deepseek", supportsReasoningEffort: false };
				}

				// Fix known mismatches between models.dev npm data and actual
				// OpenCode Go endpoint behaviour. models.dev reports these models
				// as @ai-sdk/anthropic, but the OpenCode Go endpoints either don't
				// accept Anthropic SDK auth (MiniMax M2.7) or are served through
				// the OpenAI-compatible /v1/chat/completions path (Qwen 3.5/3.6).
				// Switch them to openai-completions so requests use Bearer auth
				// and the standard /v1/chat/completions endpoint.
				if (variant.provider === "opencode-go") {
					if (modelId === "minimax-m2.7") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
					}
					if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
						// Qwen/DashScope uses enable_thinking at the top level.
						compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
					}
				}

				if (api === "openai-completions") {
					compat = { ...(compat ?? {}), maxTokensField: "max_tokens" };
					if (
						OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS.has(
							`${variant.provider}:${modelId}`,
						)
					) {
						compat = { ...compat, supportsLongCacheRetention: false };
					}
				}

				models.push({
					id: modelId,
					name: m.name || modelId,
					api,
					provider: variant.provider,
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					...(compat ? { compat } : {}),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(variant.provider, modelId, m);
			}
		}

		// Process GitHub Copilot models
		if (data["github-copilot"]?.models) {
			for (const [modelId, model] of Object.entries(data["github-copilot"].models)) {
				const m = model as ModelsDevModel & { status?: string };
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				// Claude 4.x and 5.x models route to Anthropic Messages API
				const isCopilotClaude = /^claude-(haiku|sonnet|opus)-[45]([.\-]|$)/.test(modelId);
				// gpt-5, oswe, and MAI-Code models are only served through the
				// Copilot /responses endpoint.
				const needsResponsesApi =
					modelId.startsWith("gpt-5") || modelId.startsWith("oswe") || modelId.startsWith("mai-");

				const api: Api = isCopilotClaude
					? "anthropic-messages"
					: needsResponsesApi
						? "openai-responses"
						: "openai-completions";

				const anthropicCompat =
					api === "anthropic-messages" ? getAnthropicMessagesCompat("github-copilot", modelId) : undefined;

				const copilotModel: Model<any> = {
					id: modelId,
					name: m.name || modelId,
					api,
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 128000,
					maxTokens: m.limit?.output || 8192,
					headers: { ...COPILOT_STATIC_HEADERS },
					...(anthropicCompat ? { compat: anthropicCompat } : {}),
					// compat only applies to openai-completions
					...(api === "openai-completions" ? {
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
					} : {}),
				};

				models.push(copilotModel);
				recordModelsDevReasoningOptions("github-copilot", modelId, m);
			}
		}

		// Process MiniMax models
		const minimaxVariants = [
			{ key: "minimax", provider: "minimax", baseUrl: "https://api.minimax.io/anthropic" },
			{ key: "minimax-cn", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic" },
		] as const;

		for (const { key, provider, baseUrl } of minimaxVariants) {
			if (data[key]?.models) {
				for (const [modelId, model] of Object.entries(data[key].models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						// MiniMax's Anthropic-compatible API - SDK appends /v1/messages
						baseUrl,
						reasoning: m.reasoning === true,
						input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
					recordModelsDevReasoningOptions(provider, modelId, m);
				}
			}
		}

		// Process Kimi For Coding models
		if (data["kimi-for-coding"]?.models) {
			const kimiModels = data["kimi-for-coding"].models as Record<string, ModelsDevModel>;
			const hasCanonicalModel = Object.prototype.hasOwnProperty.call(kimiModels, "kimi-for-coding");

			const kimiAliases = new Set(["k2p5", "k2p6", "k2p7"]);

			for (const [modelId, model] of Object.entries(kimiModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev may expose versioned aliases (e.g. k2p5/k2p6/k2p7).
				// Normalize aliases to the canonical model id and drop duplicates when canonical exists.
				if (kimiAliases.has(modelId) && hasCanonicalModel) continue;

				const normalizedId = kimiAliases.has(modelId) ? "kimi-for-coding" : modelId;
				const normalizedName = kimiAliases.has(modelId) ? "Kimi For Coding" : m.name || normalizedId;
				const isKimiK3 = normalizedId === "k3";
				const allowEmptySignature = isKimiK3 || normalizedId === "kimi-for-coding";
				const impliedCost = KIMI_CODING_IMPLIED_COSTS[normalizedId];

				models.push({
					id: normalizedId,
					name: normalizedName,
					api: "anthropic-messages",
					provider: "kimi-coding",
					// Kimi For Coding's Anthropic-compatible API - SDK appends /v1/messages
					baseUrl: "https://api.kimi.com/coding",
					headers: { ...KIMI_STATIC_HEADERS },
					compat: {
						...(allowEmptySignature ? { allowEmptySignature: true } : {}),
						forceAdaptiveThinking: true,
					},
					reasoning: isKimiK3 || m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || impliedCost?.input || 0,
						output: m.cost?.output || impliedCost?.output || 0,
						cacheRead: m.cost?.cache_read || impliedCost?.cacheRead || 0,
						cacheWrite: m.cost?.cache_write || impliedCost?.cacheWrite || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("kimi-coding", normalizedId, m);
			}
		}

		// Process Moonshot AI models
		const moonshotVariants = [
			{ key: "moonshotai", provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" },
			{ key: "moonshotai-cn", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1" },
		] as const;
		const moonshotCompat: OpenAICompletionsCompat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
		};
		const getMoonshotProviderModels = (key: "moonshotai" | "moonshotai-cn"): Record<string, ModelsDevModel> => {
			const providerModels = data[key]?.models as Record<string, ModelsDevModel> | undefined;
			return providerModels ? { ...providerModels } : {};
		};
		const moonshotModels = {
			moonshotai: getMoonshotProviderModels("moonshotai"),
			"moonshotai-cn": getMoonshotProviderModels("moonshotai-cn"),
		};

		for (const { key, provider, baseUrl } of moonshotVariants) {
			for (const [modelId, m] of Object.entries(moonshotModels[key])) {
				if (m.tool_call !== true) continue;

				const isKimiK3 = modelId === "kimi-k3";
				const compat = isKimiK3 ? { ...moonshotCompat } : moonshotCompat;
				if (isKimiK3) {
					compat.requiresReasoningContentOnAssistantMessages = true;
					compat.deferredToolsMode = "kimi";
					compat.thinkingFormat = "openai";
					compat.supportsReasoningEffort = true;
				}
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: isKimiK3 || m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || (isKimiK3 ? KIMI_K3_COST.input : 0),
						output: m.cost?.output || (isKimiK3 ? KIMI_K3_COST.output : 0),
						cacheRead: m.cost?.cache_read || (isKimiK3 ? KIMI_K3_COST.cacheRead : 0),
						cacheWrite: m.cost?.cache_write || (isKimiK3 ? KIMI_K3_COST.cacheWrite : 0),
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Xiaomi MiMo models
		// Built-in `xiaomi` targets the API billing endpoint (single stable URL,
		// keys from platform.xiaomimimo.com). The three `xiaomi-token-plan-*`
		// providers cover prepaid Token Plan endpoints in cn / ams / sgp.
		const xiaomiCompat: OpenAICompletionsCompat = {
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		};
		const xiaomiVariants = [
			{ source: "xiaomi", provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1" },
			{
				source: "xiaomi-token-plan-cn",
				provider: "xiaomi-token-plan-cn",
				baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-ams",
				provider: "xiaomi-token-plan-ams",
				baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-sgp",
				provider: "xiaomi-token-plan-sgp",
				baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
		] as const;

		for (const { source, provider, baseUrl } of xiaomiVariants) {
			const providerModels = data[source]?.models;
			if (!providerModels) continue;

			for (const [modelId, model] of Object.entries(providerModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: xiaomiCompat,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Alibaba Cloud Model Studio Token Plan models
		// Two regions (international / cn) with identical catalogs, separate
		// endpoints and API keys (sk-sp- prefix). models.dev keys are
		// "alibaba-token-plan[-cn]"; pi exposes them as "qwen-token-plan[-cn]".
		const qwenTokenPlanCompat: OpenAICompletionsCompat = {
			thinkingFormat: "qwen",
			supportsDeveloperRole: false,
			supportsStore: false,
		};
		const qwenTokenPlanVariants = [
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan",
				baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
			},
			{
				source: "alibaba-token-plan-cn",
				provider: "qwen-token-plan-cn",
				baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
			},
		] as const;

		for (const { source, provider, baseUrl } of qwenTokenPlanVariants) {
			const providerModels = data[source]?.models;
			if (!providerModels) continue;

			for (const [modelId, model] of Object.entries(providerModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: qwenTokenPlanCompat,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

async function generateModels() {
	// Fetch models from both sources
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras
	// OpenRouter: xAI and other providers (excluding Anthropic, Google, OpenAI)
	// AI Gateway: OpenAI-compatible catalog with tool-capable models
	const modelsDevModels = await loadModelsDevData();
	const openRouterModels = await fetchOpenRouterModels();
	const aiGatewayModels = await fetchAiGatewayModels();

	// Combine models (models.dev has priority)
	const allModels = [...modelsDevModels, ...openRouterModels, ...aiGatewayModels].filter(
		(model) =>
			!(model.provider === "xai" && XAI_BUILTIN_EXCLUDED_MODEL_IDS.has(model.id)) &&
			!((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "gpt-5.3-codex-spark"),
	);

	// Temporary overrides until upstream model metadata is corrected.
	for (const candidate of allModels) {
		if (candidate.provider === "github-copilot" && GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS.has(candidate.id)) {
			candidate.contextWindow = 1000000;
		}

		if (
			(candidate.provider === "anthropic" ||
				candidate.provider === "opencode" ||
				candidate.provider === "opencode-go") &&
			(candidate.id === "claude-opus-4-6" ||
				candidate.id === "claude-sonnet-4-6" ||
				candidate.id === "claude-opus-4.6" ||
				candidate.id === "claude-sonnet-4.6")
		) {
			candidate.contextWindow = 1000000;
		}

		// OpenCode variants list Claude Sonnet 4/4.5 with 1M context, actual limit is 200K
		if (
			(candidate.provider === "opencode" || candidate.provider === "opencode-go") &&
			(candidate.id === "claude-sonnet-4-5" || candidate.id === "claude-sonnet-4")
		) {
			candidate.contextWindow = 200000;
		}
		if ((candidate.provider === "opencode" || candidate.provider === "opencode-go") && candidate.id === "gpt-5.4") {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		// Keep direct OpenAI requests in the short-context pricing tier by default. Users can opt into the
		// larger context through model overrides, so retain long-context cost metadata on the capped models.
		if (candidate.provider === "openai" && OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS.has(candidate.id)) {
			candidate.contextWindow = OPENAI_LONG_CONTEXT_INPUT_THRESHOLD;
			candidate.maxTokens = 128000;
		}
		if (candidate.provider === "openai" && OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS.has(candidate.id)) {
			candidate.cost = withOpenAiLongContextPricing(candidate.cost);
		}
		// models.dev reports gpt-5-pro output as 272000 (a duplicate of the input sub-limit);
		// the actual max output is 128000. Also propagates to the derived Azure clone.
		if (candidate.provider === "openai" && candidate.id === "gpt-5-pro") {
			candidate.maxTokens = 128000;
		}
		// Keep Kimi K3's canonical output limit when gateway metadata is missing or incorrect.
		if (
			(candidate.provider === "openrouter" && OPENROUTER_KIMI_K3_MODEL_IDS.has(candidate.id)) ||
			(candidate.provider === "vercel-ai-gateway" && candidate.id === "moonshotai/kimi-k3")
		) {
			candidate.maxTokens = KIMI_K3_MAX_TOKENS;
		}
		// Keep selected OpenRouter model metadata stable until upstream settles.
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k2.5") {
			candidate.cost.input = 0.41;
			candidate.cost.output = 2.06;
			candidate.cost.cacheRead = 0.07;
			candidate.maxTokens = 4096;
		}
		if (candidate.provider === "openrouter" && candidate.id.startsWith("moonshotai/kimi-k2.6")) {
			candidate.compat = {
				...candidate.compat,
				supportsDeveloperRole: false,
				requiresReasoningContentOnAssistantMessages: true,
			};
		}
		if (candidate.provider === "openrouter" && candidate.id === "z-ai/glm-5") {
			candidate.cost.input = 0.6;
			candidate.cost.output = 1.9;
			candidate.cost.cacheRead = 0.119;
		}
		if (candidate.provider === "fireworks" && candidate.id.includes("glm-5p2")) {
			candidate.api = "openai-completions";
			candidate.baseUrl = "https://api.fireworks.ai/inference/v1";
			candidate.compat = { supportsStore: false, supportsDeveloperRole: false };
		}
	}


	// Add missing gpt models
	const missingOpenAiModels: Model<"openai-responses">[] = [
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 }),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 }),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		},
	];
	for (const model of missingOpenAiModels) {
		if (!allModels.some((m) => m.provider === model.provider && m.id === model.id)) {
			allModels.push(model);
		}
	}

	const deepseekCompat: OpenAICompletionsCompat = {
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	};
	const deepseekV4Models: Model<"openai-completions">[] = [
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.14,
				output: 0.28,
				cacheRead: 0.0028,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.435,
				output: 0.87,
				cacheRead: 0.003625,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
	];
	allModels.push(...deepseekV4Models);

	const antLingCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsLongCacheRetention: false,
	};
	const antLingModels: Model<"openai-completions">[] = [
		{
			id: "Ling-2.6-flash",
			name: "Ling 2.6 Flash",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: antLingCompat,
		},
		{
			id: "Ling-2.6-1T",
			name: "Ling 2.6 1T",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: antLingCompat,
		},
		{
			id: "Ring-2.6-1T",
			name: "Ring 2.6 1T",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: { ...antLingCompat, thinkingFormat: "ant-ling" },
		},
	];
	allModels.push(...antLingModels);

	for (const candidate of allModels) {
		if (candidate.api === "openai-completions" && candidate.id.includes("deepseek-v4")) {
			const preservesNativeReasoningEffort = candidate.provider === "openrouter" || candidate.provider === "opencode";
			candidate.compat = {
				...candidate.compat,
				...(preservesNativeReasoningEffort
					? {
							requiresReasoningContentOnAssistantMessages:
								deepseekCompat.requiresReasoningContentOnAssistantMessages,
						}
					: deepseekCompat),
			};
		}
	}

	const minimaxDirectSupportedIds = new Set(["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M3"]);

	for (let i = allModels.length - 1; i >= 0; i--) {
		const candidate = allModels[i];
		if (
			(candidate.provider === "minimax" || candidate.provider === "minimax-cn") &&
			!minimaxDirectSupportedIds.has(candidate.id)
		) {
			allModels.splice(i, 1);
		}
	}

	// OpenAI Codex (ChatGPT OAuth) models
	// NOTE: These are not fetched from models.dev; we keep a small, explicit list to avoid aliases.
	// Older model limits are based on observed server behavior; GPT-5.6 follows Codex's 272k catalog limit (formerly 372k).
	const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
	const CODEX_CONTEXT = 272000;
	const CODEX_GPT_56_CONTEXT = 272000;
	const CODEX_SPARK_CONTEXT = 128000;
	const CODEX_MAX_TOKENS = 128000;
	const codexModels: Model<"openai-codex-responses">[] = [
		{
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_SPARK_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 }),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 }),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
	];
	allModels.push(...codexModels);

	// Add missing Mistral Medium 3.5 model until models.dev includes it
	if (!allModels.some(m => m.provider === "mistral" && m.id === "mistral-medium-3.5")) {
		allModels.push({
			id: "mistral-medium-3.5",
			name: "Mistral Medium 3.5",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.5,
				output: 7.5,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144, // 256k tokens
			maxTokens: 262144,
		});
	}

	// Add qwen3.8-max-preview to Qwen Token Plan providers until models.dev includes it
	for (const qwenTpProvider of ["qwen-token-plan", "qwen-token-plan-cn"] as const) {
		if (!allModels.some((m) => m.provider === qwenTpProvider && m.id === "qwen3.8-max-preview")) {
			const baseUrl =
				qwenTpProvider === "qwen-token-plan"
					? "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
					: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
			allModels.push({
				id: "qwen3.8-max-preview",
				name: "Qwen3.8 Max Preview",
				api: "openai-completions",
				provider: qwenTpProvider,
				baseUrl,
				compat: { thinkingFormat: "qwen", supportsDeveloperRole: false, supportsStore: false } satisfies OpenAICompletionsCompat,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 65536,
			});
		}
	}

	// Add "auto" alias for openrouter/auto
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "auto")) {
		allModels.push({
			id: "auto",
			name: "Auto",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// we dont know about the costs because OpenRouter auto routes to different models
				// and then charges you for the underlying used model
				input:0,
				output:0,
				cacheRead:0,
				cacheWrite:0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	// Add "fusion" alias for openrouter/fusion. OpenRouter exposes Fusion as a
	// router alias/plugin entry point; its model metadata does not advertise
	// tools, but the alias resolves to a concrete model that can invoke caller
	// tools and has the openrouter:fusion server tool auto-injected.
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "openrouter/fusion")) {
		allModels.push({
			id: "openrouter/fusion",
			name: "OpenRouter: Fusion",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				// we dont know about the costs because Fusion routes to multiple models
				// and then charges you for the underlying used models
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 30000,
		});
	}

	// Azure Foundry deploys these with larger context windows than OpenAI's own short-tier defaults.
	// See models-sold-directly-by-azure docs.
	const AZURE_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
		"gpt-5.4": 1050000,
		"gpt-5.5": 1050000,
		"gpt-5.6-luna": 1050000,
		"gpt-5.6-sol": 1050000,
		"gpt-5.6-terra": 1050000,
	};
	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "",
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: AZURE_CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.contextWindow,
		}));
	allModels.push(...azureOpenAiModels);

	for (const model of allModels) {
		applyOpenAICompletionsCompatMetadata(model);
		applyModelsDevReasoningOptionMetadata(model);
		applyThinkingLevelMetadata(model);
		applyStrictToolCompatMetadata(model);
		applyOpenAIGrammarToolCompatMetadata(model);
		applyOpenAIToolSearchMetadata(model);
		applyOpenAIExplicitPromptCacheMetadata(model);
	}

	// Group by provider and deduplicate by model ID
	const providers: Record<string, Record<string, Model<any>>> = {};
	for (const model of allModels) {
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// Use model ID as key to automatically deduplicate
		// Only add if not already present (models.dev takes priority over OpenRouter)
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	const sortedProviderIds = Object.keys(providers).sort();
	const jsonProviders: Record<string, Record<string, Model<any>>> = {};
	for (const providerId of sortedProviderIds) {
		jsonProviders[providerId] = {};
		for (const modelId of Object.keys(providers[providerId]).sort()) {
			jsonProviders[providerId][modelId] = providers[providerId][modelId];
		}
	}

	const serializeJson = (value: unknown) => `${JSON.stringify(value, null, generatorOptions.pretty ? 2 : undefined)}\n`;
	const writeJson = (path: string, value: unknown) => writeFileSync(path, serializeJson(value));
	const generatedDataProviderIds = generatorOptions.dataOnly
		? readModelDataProviderIds(packageRoot)
		: sortedProviderIds;
	const missingProviderIds = generatedDataProviderIds.filter((providerId) => !jsonProviders[providerId]);
	if (missingProviderIds.length > 0) {
		throw new Error(`Cannot hydrate missing providers: ${missingProviderIds.join(", ")}`);
	}

	// Only the ignored internal data is grouped by API for type derivation. Public JSON catalog output stays flat.
	const generatedDataProviders: Record<string, Record<string, Record<string, Model<Api>>>> = {};
	const modelDataStructure: ModelDataStructure = {};
	for (const providerId of generatedDataProviderIds) {
		const models = jsonProviders[providerId];
		generatedDataProviders[providerId] = {};
		modelDataStructure[providerId] = {};
		const apiIds = Array.from(new Set(Object.values(models).map((model) => model.api))).sort();
		for (const api of apiIds) {
			generatedDataProviders[providerId][api] = {};
			for (const [modelId, model] of Object.entries(models)) {
				if (model.api !== api) continue;
				generatedDataProviders[providerId][api][modelId] = model;
				modelDataStructure[providerId][modelId] = api;
			}
		}
	}

	const generatedAt = new Date().toISOString();

	if (!generatorOptions.jsonOnly) {
		// Stage and validate all provider values before replacing the current generated data.
		const providersDir = join(packageRoot, "src/providers");
		const dataDir = join(providersDir, "data");
		const stagingRoot = mkdtempSync(join(providersDir, ".model-generation-"));
		const stagedDataDir = join(stagingRoot, "data");
		const previousDataDir = join(stagingRoot, "previous-data");
		let restoreGeneratedCatalog: (() => void) | undefined;
		try {
			mkdirSync(stagedDataDir, { recursive: true });
			const fileContents: Record<string, string> = {};
			for (const providerId of generatedDataProviderIds) {
				const filename = `${providerId}.json`;
				const content = serializeJson(generatedDataProviders[providerId]);
				fileContents[filename] = content;
				writeFileSync(join(stagedDataDir, filename), content);
			}
			writeJson(
				join(stagedDataDir, MODEL_DATA_MANIFEST_FILE),
				createModelDataManifest(modelDataStructure, fileContents, generatedAt),
			);
			validateModelDataDirectory(modelDataStructure, stagedDataDir);

			if (!generatorOptions.dataOnly) {
				const previousShardContents = new Map(
					readdirSync(providersDir)
						.filter((entry) => entry.endsWith(".models.ts"))
						.map((entry) => [entry, readFileSync(join(providersDir, entry), "utf8")] as const),
				);
				const aggregatorPath = join(packageRoot, "src/models.generated.ts");
				const previousAggregator = readFileSync(aggregatorPath, "utf8");
				restoreGeneratedCatalog = () => {
					for (const entry of readdirSync(providersDir)) {
						if (entry.endsWith(".models.ts")) rmSync(join(providersDir, entry));
					}
					for (const [entry, content] of previousShardContents) {
						writeFileSync(join(providersDir, entry), content);
					}
					writeFileSync(aggregatorPath, previousAggregator);
				};

				const generatedHeader = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

`;
				const catalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
				const generatedShardFiles = new Set<string>();
				for (const providerId of sortedProviderIds) {
					let output = generatedHeader;
					output += `import values from "./data/${providerId}.json" with { type: "json" };\n`;
					output += `import { flattenModelCatalog, type ModelCatalog } from "../model-catalog.ts";\n\n`;
					output += `export const ${catalogConstName(providerId)}: ModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenModelCatalog(${JSON.stringify(providerId)}, values);\n`;
					const filename = `${providerId}.models.ts`;
					generatedShardFiles.add(filename);
					writeFileSync(join(providersDir, filename), output);
				}
				for (const entry of readdirSync(providersDir)) {
					if (entry.endsWith(".models.ts") && !generatedShardFiles.has(entry)) rmSync(join(providersDir, entry));
				}

				let output = generatedHeader;
				for (const providerId of sortedProviderIds) {
					output += `import { ${catalogConstName(providerId)} } from "./providers/${providerId}.models.ts";\n`;
				}
				output += `\nexport const MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${catalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${catalogConstName(providerId)},\n`;
				}
				output += `};\n`;
				writeFileSync(aggregatorPath, output);
				console.log("Generated provider catalogs and src/models.generated.ts");
			}

			const hadPreviousData = existsSync(dataDir);
			if (hadPreviousData) renameSync(dataDir, previousDataDir);
			try {
				renameSync(stagedDataDir, dataDir);
				validateGeneratedModelData(packageRoot);
			} catch (error) {
				rmSync(dataDir, { recursive: true, force: true });
				if (hadPreviousData && existsSync(previousDataDir)) renameSync(previousDataDir, dataDir);
				throw error;
			}
			restoreGeneratedCatalog = undefined;
			console.log(
				generatorOptions.dataOnly
					? "Hydrated JSON model values under src/providers/data/"
					: "Generated JSON model values under src/providers/data/",
			);
		} catch (error) {
			restoreGeneratedCatalog?.();
			throw error;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	if (generatorOptions.jsonOutputDir) {
		const providerOutputDir = join(generatorOptions.jsonOutputDir, "providers");
		rmSync(generatorOptions.jsonOutputDir, { recursive: true, force: true });
		mkdirSync(providerOutputDir, { recursive: true });
		writeJson(join(generatorOptions.jsonOutputDir, "models.json"), jsonProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "providers.json"), sortedProviderIds);
		for (const providerId of sortedProviderIds) {
			writeJson(join(providerOutputDir, `${providerId}.json`), jsonProviders[providerId]);
		}
		console.log(`Generated JSON model catalog under ${generatorOptions.jsonOutputDir}`);
	}

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

// Run the generator
generateModels().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
