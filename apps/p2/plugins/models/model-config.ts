// Adapted from earendil-works/pi (MIT); see third-party/pi.LICENSE.
/** Immutable, credential-blind models.json snapshot. */

import { readFile } from "node:fs/promises";
import {
	arr,
	bool,
	compile,
	int,
	nul,
	num,
	obj,
	opt,
	type Static,
	str,
	union,
	unknown,
	type ValidationError,
} from "@earendil-works/pi-schema";
import { literal, record } from "@p2/app/v1";
import { normalizePath, stripBom, stripJsonComments } from "@p2/app/v1/node";

const PercentileCutoffsSchema = obj(
	{
		p50: opt(num()),
		p75: opt(num()),
		p90: opt(num()),
		p99: opt(num()),
	},
	{ open: true },
);

const OpenRouterRoutingSchema = obj(
	{
		allow_fallbacks: opt(bool()),
		require_parameters: opt(bool()),
		data_collection: opt(union([literal("deny"), literal("allow")])),
		zdr: opt(bool()),
		enforce_distillable_text: opt(bool()),
		order: opt(arr(str())),
		only: opt(arr(str())),
		ignore: opt(arr(str())),
		quantizations: opt(arr(str())),
		sort: opt(
			union([
				str(),
				obj(
					{
						by: opt(str()),
						partition: opt(union([str(), nul()])),
					},
					{ open: true },
				),
			]),
		),
		max_price: opt(
			obj(
				{
					prompt: opt(union([num(), str()])),
					completion: opt(union([num(), str()])),
					image: opt(union([num(), str()])),
					audio: opt(union([num(), str()])),
					request: opt(union([num(), str()])),
				},
				{ open: true },
			),
		),
		preferred_min_throughput: opt(union([num(), PercentileCutoffsSchema])),
		preferred_max_latency: opt(union([num(), PercentileCutoffsSchema])),
	},
	{ open: true },
);

const VercelGatewayRoutingSchema = obj(
	{
		only: opt(arr(str())),
		order: opt(arr(str())),
	},
	{ open: true },
);

const ThinkingLevelMapValueSchema = union([str(), nul()]);
const ThinkingLevelMapSchema = obj(
	{
		off: opt(ThinkingLevelMapValueSchema),
		minimal: opt(ThinkingLevelMapValueSchema),
		low: opt(ThinkingLevelMapValueSchema),
		medium: opt(ThinkingLevelMapValueSchema),
		high: opt(ThinkingLevelMapValueSchema),
		xhigh: opt(ThinkingLevelMapValueSchema),
		max: opt(ThinkingLevelMapValueSchema),
	},
	{ open: true },
);

const ChatTemplateKwargScalarSchema = union([str(), num(), bool(), nul()]);
const ChatTemplateKwargVariableSchema = obj(
	{
		$var: union([literal("thinking.enabled"), literal("thinking.effort")]),
		omitWhenOff: opt(bool()),
	},
	{ open: true },
);
const ChatTemplateKwargSchema = union([ChatTemplateKwargScalarSchema, ChatTemplateKwargVariableSchema]);

const OpenAICompletionsCompatSchema = obj(
	{
		supportsStore: opt(bool()),
		supportsDeveloperRole: opt(bool()),
		supportsReasoningEffort: opt(bool()),
		supportsUsageInStreaming: opt(bool()),
		supportsFinishReason: opt(bool()),
		maxTokensField: opt(union([literal("max_completion_tokens"), literal("max_tokens")])),
		requiresToolResultName: opt(bool()),
		requiresAssistantAfterToolResult: opt(bool()),
		requiresThinkingAsText: opt(bool()),
		requiresReasoningContentOnAssistantMessages: opt(bool()),
		thinkingFormat: opt(
			union([
				literal("openai"),
				literal("openrouter"),
				literal("together"),
				literal("baseten"),
				literal("deepseek"),
				literal("zai"),
				literal("qwen"),
				literal("chat-template"),
				literal("qwen-chat-template"),
				literal("string-thinking"),
				literal("ant-ling"),
			]),
		),
		chatTemplateKwargs: opt(record(ChatTemplateKwargSchema)),
		chatTemplateArgs: opt(record(ChatTemplateKwargSchema)),
		cacheControlFormat: opt(literal("anthropic")),
		openRouterRouting: opt(OpenRouterRoutingSchema),
		vercelGatewayRouting: opt(VercelGatewayRoutingSchema),
		supportsOpenAIGrammarTools: opt(bool()),
		supportsStrictMode: opt(bool()),
		sendSessionAffinityHeaders: opt(bool()),
		sessionAffinityFormat: opt(union([literal("openai"), literal("openai-nosession"), literal("openrouter")])),
		supportsLongCacheRetention: opt(bool()),
		vllmPriority: opt(num()),
	},
	{ open: true },
);

const OpenAIResponsesCompatSchema = obj(
	{
		supportsDeveloperRole: opt(bool()),
		sessionAffinityFormat: opt(union([literal("openai"), literal("openai-nosession"), literal("openrouter")])),
		supportsLongCacheRetention: opt(bool()),
		supportsStrictMode: opt(bool()),
		supportsOpenAIGrammarTools: opt(bool()),
		supportsMaxOutputTokens: opt(bool()),
	},
	{ open: true },
);

const ModelCostRatesSchema = {
	input: num(),
	output: num(),
	cacheRead: num(),
	cacheWrite: num(),
};
const ModelCostTierSchema = obj(
	{
		inputTokensAbove: num(),
		...ModelCostRatesSchema,
	},
	{ open: true },
);
const ModelCostSchema = obj(
	{
		...ModelCostRatesSchema,
		tiers: opt(arr(ModelCostTierSchema)),
	},
	{ open: true },
);
const ModelPromptCacheSchema = obj(
	{
		short: opt(num({ exclusiveMinimum: 0 })),
		long: opt(num({ exclusiveMinimum: 0 })),
	},
	{ open: true },
);
const ImageResizeSchema = obj(
	{
		maxWidth: opt(int({ minimum: 1 })),
		maxHeight: opt(int({ minimum: 1 })),
		maxBytes: opt(int({ minimum: 1 })),
		jpegQuality: opt(int({ minimum: 1, maximum: 100 })),
	},
	{ open: true },
);
const ModelInputLimitsSchema = obj(
	{
		maxRequestBytes: opt(int({ minimum: 1 })),
		images: opt(
			obj(
				{
					resize: opt(ImageResizeSchema),
					maxPerMessage: opt(int({ minimum: 1 })),
					maxPerRequest: opt(int({ minimum: 1 })),
				},
				{ open: true },
			),
		),
	},
	{ open: true },
);

const AnthropicMessagesCompatSchema = obj(
	{
		supportsEagerToolInputStreaming: opt(bool()),
		supportsLongCacheRetention: opt(bool()),
		sendSessionAffinityHeaders: opt(bool()),
		supportsCacheControlOnTools: opt(bool()),
		supportsTemperature: opt(bool()),
		forceAdaptiveThinking: opt(bool()),
		allowEmptySignature: opt(bool()),
		supportsStrictTools: opt(bool()),
		supportsMidConvoEffort: opt(bool()),
		allowedFallbackModels: opt(
			arr(
				obj(
					{
						provider: str({ minLength: 1 }),
						model: str({ minLength: 1 }),
						cost: ModelCostSchema,
					},
					{ open: true },
				),
				{ maxItems: 3 },
			),
		),
	},
	{ open: true },
);

const ProviderCompatSchema = union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);

const ModelDefinitionSchema = obj(
	{
		id: str({ minLength: 1 }),
		name: opt(str({ minLength: 1 })),
		api: opt(str({ minLength: 1 })),
		baseUrl: opt(str({ minLength: 1 })),
		reasoning: opt(bool()),
		thinkingLevelMap: opt(ThinkingLevelMapSchema),
		input: opt(arr(union([literal("text"), literal("image")]))),
		inputLimits: opt(ModelInputLimitsSchema),
		cost: opt(ModelCostSchema),
		promptCache: opt(ModelPromptCacheSchema),
		contextWindow: opt(num()),
		maxTokens: opt(num()),
		samplingParams: opt(record(unknown())),
		headers: opt(record(str())),
		compat: opt(ProviderCompatSchema),
	},
	{ open: true },
);

const ModelOverrideSchema = obj(
	{
		name: opt(str({ minLength: 1 })),
		reasoning: opt(bool()),
		thinkingLevelMap: opt(ThinkingLevelMapSchema),
		input: opt(arr(union([literal("text"), literal("image")]))),
		inputLimits: opt(ModelInputLimitsSchema),
		cost: opt(
			obj(
				{
					input: opt(num()),
					output: opt(num()),
					cacheRead: opt(num()),
					cacheWrite: opt(num()),
					tiers: opt(arr(ModelCostTierSchema)),
				},
				{ open: true },
			),
		),
		promptCache: opt(ModelPromptCacheSchema),
		contextWindow: opt(num()),
		maxTokens: opt(num()),
		samplingParams: opt(record(unknown())),
		headers: opt(record(str())),
		compat: opt(ProviderCompatSchema),
	},
	{ open: true },
);

const ProviderConfigSchema = obj(
	{
		name: opt(str({ minLength: 1 })),
		baseUrl: opt(str({ minLength: 1 })),
		apiKey: opt(str({ minLength: 1 })),
		api: opt(str({ minLength: 1 })),
		oauth: opt(literal("radius")),
		headers: opt(record(str())),
		compat: opt(ProviderCompatSchema),
		authHeader: opt(bool()),
		models: opt(arr(ModelDefinitionSchema)),
		modelOverrides: opt(record(ModelOverrideSchema)),
	},
	{ open: true },
);

const ModelsConfigSchema = obj(
	{
		providers: record(ProviderConfigSchema),
	},
	{ open: true },
);
const validateModelsConfig = compile(ModelsConfigSchema);

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;
type ModelsJson = Static<typeof ModelsConfigSchema>;

/** `providers.openai.models.0.id` for the JSON Pointer `/providers/openai/models/0/id` (a missing field's own path). */
function formatValidationPath(error: ValidationError): string {
	if (error.path === "") return "root";
	return error.path
		.slice(1)
		.split("/")
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
		.join(".");
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly error: string | undefined;

	private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
		this.providers = providers;
		this.error = error;
	}

	static async load(modelsJsonPath: string): Promise<ModelConfig> {
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(
				new Map(),
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch {
			return new ModelConfig(new Map(), `Invalid models.json syntax. File: ${path}`);
		}

		if (!validateModelsConfig.check(parsed)) {
			const errors =
				validateModelsConfig
					.errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		const config = parsed as ModelsJson;
		const providers = new Map<string, ModelsJsonProvider>();
		for (const [providerId, provider] of Object.entries(config.providers)) {
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		return new ModelConfig(providers);
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	getError(): string | undefined {
		return this.error;
	}
}
