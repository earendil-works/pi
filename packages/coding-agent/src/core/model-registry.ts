/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
	type OAuthProviderInterface,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	registerApiProvider,
	resetApiProviders,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@mariozechner/pi-ai/oauth";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.js";
import type { AuthStorage } from "./auth-storage.js";
import { clearConfigValueCache, resolveConfigValue, resolveHeaders } from "./resolve-config-value.js";

interface ReasoningEffortMap {
	minimal?: string;
	low?: string;
	medium?: string;
	high?: string;
	xhigh?: string;
}

interface OpenRouterRouting {
	only?: string[];
	order?: string[];
}

interface VercelGatewayRouting {
	only?: string[];
	order?: string[];
}

interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface PartialModelCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

interface ModelsJsonModelDefinition {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	cost?: ModelCost;
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}

interface ModelOverride {
	name?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	cost?: PartialModelCost;
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}

interface ModelsJsonProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
	authHeader?: boolean;
	models?: ModelsJsonModelDefinition[];
	modelOverrides?: Record<string, ModelOverride>;
}

interface ModelsConfig {
	providers: Record<string, ModelsJsonProviderConfig>;
}

const VALID_MODEL_INPUT_TYPES = new Set(["text", "image"]);
const VALID_MAX_TOKENS_FIELDS = new Set(["max_completion_tokens", "max_tokens"]);
const VALID_THINKING_FORMATS = new Set(["openai", "openrouter", "zai", "qwen", "qwen-chat-template"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function pushExpectedObjectError(errors: string[], path: string): void {
	errors.push(`  - ${path}: expected object`);
}

function parseStringArray(path: string, value: unknown, errors: string[]): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		errors.push(`  - ${path}: expected array of strings`);
		return undefined;
	}
	return value;
}

function parseStringRecord(path: string, value: unknown, errors: string[]): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		pushExpectedObjectError(errors, path);
		return undefined;
	}
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			errors.push(`  - ${path}/${key}: expected string`);
			continue;
		}
		result[key] = entry;
	}
	return result;
}

function parseModelCost(
	path: string,
	value: unknown,
	errors: string[],
	partial: boolean,
): ModelCost | PartialModelCost | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		pushExpectedObjectError(errors, path);
		return undefined;
	}

	const result: PartialModelCost = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const entry = value[key];
		if (entry === undefined) {
			if (!partial) {
				errors.push(`  - ${path}/${key}: expected number`);
			}
			continue;
		}
		if (typeof entry !== "number") {
			errors.push(`  - ${path}/${key}: expected number`);
			continue;
		}
		result[key] = entry;
	}

	return partial ? result : (result as ModelCost);
}

function parseCompat(
	path: string,
	value: unknown,
	errors: string[],
): OpenAICompletionsCompat | OpenAIResponsesCompat | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		pushExpectedObjectError(errors, path);
		return undefined;
	}

	const compat: OpenAICompletionsCompat = {};

	for (const key of [
		"supportsStore",
		"supportsDeveloperRole",
		"supportsReasoningEffort",
		"supportsUsageInStreaming",
		"requiresToolResultName",
		"requiresAssistantAfterToolResult",
		"requiresThinkingAsText",
		"supportsStrictMode",
	] as const) {
		const entry = value[key];
		if (entry === undefined) continue;
		if (typeof entry !== "boolean") {
			errors.push(`  - ${path}/${key}: expected boolean`);
			continue;
		}
		compat[key] = entry;
	}

	const maxTokensField = value.maxTokensField;
	if (maxTokensField !== undefined) {
		if (typeof maxTokensField !== "string" || !VALID_MAX_TOKENS_FIELDS.has(maxTokensField)) {
			errors.push(`  - ${path}/maxTokensField: invalid value`);
		} else {
			compat.maxTokensField = maxTokensField as OpenAICompletionsCompat["maxTokensField"];
		}
	}

	const thinkingFormat = value.thinkingFormat;
	if (thinkingFormat !== undefined) {
		if (typeof thinkingFormat !== "string" || !VALID_THINKING_FORMATS.has(thinkingFormat)) {
			errors.push(`  - ${path}/thinkingFormat: invalid value`);
		} else {
			compat.thinkingFormat = thinkingFormat as OpenAICompletionsCompat["thinkingFormat"];
		}
	}

	const reasoningEffortMapValue = value.reasoningEffortMap;
	if (reasoningEffortMapValue !== undefined) {
		if (!isRecord(reasoningEffortMapValue)) {
			pushExpectedObjectError(errors, `${path}/reasoningEffortMap`);
		} else {
			const reasoningEffortMap: ReasoningEffortMap = {};
			for (const key of ["minimal", "low", "medium", "high", "xhigh"] as const) {
				const entry = reasoningEffortMapValue[key];
				if (entry === undefined) continue;
				if (typeof entry !== "string") {
					errors.push(`  - ${path}/reasoningEffortMap/${key}: expected string`);
					continue;
				}
				reasoningEffortMap[key] = entry;
			}
			compat.reasoningEffortMap = reasoningEffortMap;
		}
	}

	for (const [routingKey, compatKey] of [
		["openRouterRouting", "openRouterRouting"],
		["vercelGatewayRouting", "vercelGatewayRouting"],
	] as const) {
		const routingValue = value[routingKey];
		if (routingValue === undefined) continue;
		if (!isRecord(routingValue)) {
			pushExpectedObjectError(errors, `${path}/${routingKey}`);
			continue;
		}
		const routing = {
			only: parseStringArray(`${path}/${routingKey}/only`, routingValue.only, errors),
			order: parseStringArray(`${path}/${routingKey}/order`, routingValue.order, errors),
		};
		compat[compatKey] = routing as OpenRouterRouting & VercelGatewayRouting;
	}

	return compat;
}

function parseModelInput(path: string, value: unknown, errors: string[]): Array<"text" | "image"> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		errors.push(`  - ${path}: expected array`);
		return undefined;
	}
	const input: Array<"text" | "image"> = [];
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (typeof entry !== "string" || !VALID_MODEL_INPUT_TYPES.has(entry)) {
			errors.push(`  - ${path}/${i}: invalid value`);
			continue;
		}
		input.push(entry as "text" | "image");
	}
	return input;
}

function parseModelDefinition(path: string, value: unknown, errors: string[]): ModelsJsonModelDefinition | undefined {
	if (!isRecord(value)) {
		pushExpectedObjectError(errors, path);
		return undefined;
	}

	const id = value.id;
	if (!isNonEmptyString(id)) {
		errors.push(`  - ${path}/id: expected non-empty string`);
		return undefined;
	}

	const name = value.name;
	const api = value.api;
	const baseUrl = value.baseUrl;
	const reasoning = value.reasoning;
	const contextWindow = value.contextWindow;
	const maxTokens = value.maxTokens;

	if (name !== undefined && !isNonEmptyString(name)) errors.push(`  - ${path}/name: expected non-empty string`);
	if (api !== undefined && !isNonEmptyString(api)) errors.push(`  - ${path}/api: expected non-empty string`);
	if (baseUrl !== undefined && !isNonEmptyString(baseUrl))
		errors.push(`  - ${path}/baseUrl: expected non-empty string`);
	if (reasoning !== undefined && typeof reasoning !== "boolean")
		errors.push(`  - ${path}/reasoning: expected boolean`);
	if (contextWindow !== undefined && typeof contextWindow !== "number")
		errors.push(`  - ${path}/contextWindow: expected number`);
	if (maxTokens !== undefined && typeof maxTokens !== "number") errors.push(`  - ${path}/maxTokens: expected number`);

	return {
		id,
		name: isNonEmptyString(name) ? name : undefined,
		api: isNonEmptyString(api) ? api : undefined,
		baseUrl: isNonEmptyString(baseUrl) ? baseUrl : undefined,
		reasoning: typeof reasoning === "boolean" ? reasoning : undefined,
		input: parseModelInput(`${path}/input`, value.input, errors),
		cost: parseModelCost(`${path}/cost`, value.cost, errors, false) as ModelCost | undefined,
		contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
		maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
		headers: parseStringRecord(`${path}/headers`, value.headers, errors),
		compat: parseCompat(`${path}/compat`, value.compat, errors),
	};
}

function parseModelOverride(path: string, value: unknown, errors: string[]): ModelOverride | undefined {
	if (!isRecord(value)) {
		pushExpectedObjectError(errors, path);
		return undefined;
	}

	const name = value.name;
	const reasoning = value.reasoning;
	const contextWindow = value.contextWindow;
	const maxTokens = value.maxTokens;

	if (name !== undefined && !isNonEmptyString(name)) errors.push(`  - ${path}/name: expected non-empty string`);
	if (reasoning !== undefined && typeof reasoning !== "boolean")
		errors.push(`  - ${path}/reasoning: expected boolean`);
	if (contextWindow !== undefined && typeof contextWindow !== "number")
		errors.push(`  - ${path}/contextWindow: expected number`);
	if (maxTokens !== undefined && typeof maxTokens !== "number") errors.push(`  - ${path}/maxTokens: expected number`);

	return {
		name: isNonEmptyString(name) ? name : undefined,
		reasoning: typeof reasoning === "boolean" ? reasoning : undefined,
		input: parseModelInput(`${path}/input`, value.input, errors),
		cost: parseModelCost(`${path}/cost`, value.cost, errors, true) as PartialModelCost | undefined,
		contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
		maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
		headers: parseStringRecord(`${path}/headers`, value.headers, errors),
		compat: parseCompat(`${path}/compat`, value.compat, errors),
	};
}

function parseProviderConfig(path: string, value: unknown, errors: string[]): ModelsJsonProviderConfig | undefined {
	if (!isRecord(value)) {
		pushExpectedObjectError(errors, path);
		return undefined;
	}

	const baseUrl = value.baseUrl;
	const apiKey = value.apiKey;
	const api = value.api;
	const authHeader = value.authHeader;

	if (baseUrl !== undefined && !isNonEmptyString(baseUrl))
		errors.push(`  - ${path}/baseUrl: expected non-empty string`);
	if (apiKey !== undefined && !isNonEmptyString(apiKey)) errors.push(`  - ${path}/apiKey: expected non-empty string`);
	if (api !== undefined && !isNonEmptyString(api)) errors.push(`  - ${path}/api: expected non-empty string`);
	if (authHeader !== undefined && typeof authHeader !== "boolean")
		errors.push(`  - ${path}/authHeader: expected boolean`);

	let models: ModelsJsonModelDefinition[] | undefined;
	if (value.models !== undefined) {
		if (!Array.isArray(value.models)) {
			errors.push(`  - ${path}/models: expected array`);
		} else {
			models = value.models
				.map((entry, index) => parseModelDefinition(`${path}/models/${index}`, entry, errors))
				.filter((entry): entry is ModelsJsonModelDefinition => entry !== undefined);
		}
	}

	let modelOverrides: Record<string, ModelOverride> | undefined;
	if (value.modelOverrides !== undefined) {
		if (!isRecord(value.modelOverrides)) {
			pushExpectedObjectError(errors, `${path}/modelOverrides`);
		} else {
			modelOverrides = {};
			for (const [modelId, overrideValue] of Object.entries(value.modelOverrides)) {
				const override = parseModelOverride(`${path}/modelOverrides/${modelId}`, overrideValue, errors);
				if (override) {
					modelOverrides[modelId] = override;
				}
			}
		}
	}

	return {
		baseUrl: isNonEmptyString(baseUrl) ? baseUrl : undefined,
		apiKey: isNonEmptyString(apiKey) ? apiKey : undefined,
		api: isNonEmptyString(api) ? api : undefined,
		headers: parseStringRecord(`${path}/headers`, value.headers, errors),
		compat: parseCompat(`${path}/compat`, value.compat, errors),
		authHeader: typeof authHeader === "boolean" ? authHeader : undefined,
		models,
		modelOverrides,
	};
}

function parseModelsConfig(value: unknown): ModelsConfig {
	const errors: string[] = [];
	if (!isRecord(value)) {
		throw new Error("Invalid models.json schema:\n  - root: expected object");
	}

	if (!isRecord(value.providers)) {
		throw new Error("Invalid models.json schema:\n  - /providers: expected object");
	}

	const providers: Record<string, ModelsJsonProviderConfig> = {};
	for (const [providerName, providerValue] of Object.entries(value.providers)) {
		const providerConfig = parseProviderConfig(`/providers/${providerName}`, providerValue, errors);
		if (providerConfig) {
			providers[providerName] = providerConfig;
		}
	}

	if (errors.length > 0) {
		throw new Error(`Invalid models.json schema:\n${errors.join("\n")}`);
	}

	return { providers };
}

/** Provider override config (baseUrl, headers, apiKey, compat) without custom models */
interface ProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	compat?: Model<Api>["compat"];
}

/** Result of loading custom models from models.json */
interface CustomModelsResult {
	models: Model<Api>[];
	/** Providers with baseUrl/headers/apiKey overrides for built-in models */
	overrides: Map<string, ProviderOverride>;
	/** Per-model overrides: provider -> modelId -> override */
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;

	const base = baseCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;
	const override = overrideCompat as OpenAICompletionsCompat | OpenAIResponsesCompat;
	const merged = { ...base, ...override } as OpenAICompletionsCompat | OpenAIResponsesCompat;

	const baseCompletions = base as OpenAICompletionsCompat | undefined;
	const overrideCompletions = override as OpenAICompletionsCompat;
	const mergedCompletions = merged as OpenAICompletionsCompat;

	if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
		mergedCompletions.openRouterRouting = {
			...baseCompletions?.openRouterRouting,
			...overrideCompletions.openRouterRouting,
		};
	}

	if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
		mergedCompletions.vercelGatewayRouting = {
			...baseCompletions?.vercelGatewayRouting,
			...overrideCompletions.vercelGatewayRouting,
		};
	}

	return merged as Model<Api>["compat"];
}

/**
 * Deep merge a model override into a model.
 * Handles nested objects (cost, compat) by merging rather than replacing.
 */
function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	// Simple field overrides
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

	// Merge cost (partial override)
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}

	// Merge headers
	if (override.headers) {
		const resolvedHeaders = resolveHeaders(override.headers);
		result.headers = resolvedHeaders ? { ...model.headers, ...resolvedHeaders } : model.headers;
	}

	// Deep merge compat
	result.compat = mergeCompat(model.compat, override.compat);

	return result;
}

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	private models: Model<Api>[] = [];
	private customProviderApiKeys: Map<string, string> = new Map();
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private loadError: string | undefined = undefined;

	constructor(
		readonly authStorage: AuthStorage,
		private modelsJsonPath: string | undefined = join(getAgentDir(), "models.json"),
	) {
		// Set up fallback resolver for custom provider API keys
		this.authStorage.setFallbackResolver((provider) => {
			const keyConfig = this.customProviderApiKeys.get(provider);
			if (keyConfig) {
				return resolveConfigValue(keyConfig);
			}
			return undefined;
		});

		// Load models
		this.loadModels();
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	refresh(): void {
		this.customProviderApiKeys.clear();
		this.loadError = undefined;

		// Ensure dynamic API/OAuth registrations are rebuilt from current provider state.
		resetApiProviders();
		resetOAuthProviders();

		this.loadModels();

		for (const [providerName, config] of this.registeredProviders.entries()) {
			this.applyProviderConfig(providerName, config);
		}
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	private loadModels(): void {
		// Load custom models and overrides from models.json
		const {
			models: customModels,
			overrides,
			modelOverrides,
			error,
		} = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();

		if (error) {
			this.loadError = error;
			// Keep built-in models even if custom models failed to load
		}

		const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
		let combined = this.mergeCustomModels(builtInModels, customModels);

		// Let OAuth providers modify their models (e.g., update baseUrl)
		for (const oauthProvider of this.authStorage.getOAuthProviders()) {
			const cred = this.authStorage.get(oauthProvider.id);
			if (cred?.type === "oauth" && oauthProvider.modifyModels) {
				combined = oauthProvider.modifyModels(combined, cred);
			}
		}

		this.models = combined;
	}

	/** Load built-in models and apply provider/model overrides */
	private loadBuiltInModels(
		overrides: Map<string, ProviderOverride>,
		modelOverrides: Map<string, Map<string, ModelOverride>>,
	): Model<Api>[] {
		return getProviders().flatMap((provider) => {
			const models = getModels(provider as KnownProvider) as Model<Api>[];
			const providerOverride = overrides.get(provider);
			const perModelOverrides = modelOverrides.get(provider);

			return models.map((m) => {
				let model = m;

				// Apply provider-level baseUrl/headers/compat override
				if (providerOverride) {
					const resolvedHeaders = resolveHeaders(providerOverride.headers);
					model = {
						...model,
						baseUrl: providerOverride.baseUrl ?? model.baseUrl,
						headers: resolvedHeaders ? { ...model.headers, ...resolvedHeaders } : model.headers,
						compat: mergeCompat(model.compat, providerOverride.compat),
					};
				}

				// Apply per-model override
				const modelOverride = perModelOverrides?.get(m.id);
				if (modelOverride) {
					model = applyModelOverride(model, modelOverride);
				}

				return model;
			});
		});
	}

	/** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
	private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
		const merged = [...builtInModels];
		for (const customModel of customModels) {
			const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
			if (existingIndex >= 0) {
				merged[existingIndex] = customModel;
			} else {
				merged.push(customModel);
			}
		}
		return merged;
	}

	private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
		if (!existsSync(modelsJsonPath)) {
			return emptyCustomModelsResult();
		}

		try {
			const content = readFileSync(modelsJsonPath, "utf-8");
			const parsed = JSON.parse(content) as unknown;
			const config = parseModelsConfig(parsed);

			// Additional validation
			this.validateConfig(config);

			const overrides = new Map<string, ProviderOverride>();
			const modelOverrides = new Map<string, Map<string, ModelOverride>>();

			for (const [providerName, providerConfig] of Object.entries(config.providers)) {
				// Apply provider-level baseUrl/headers/apiKey/compat override to built-in models when configured.
				if (providerConfig.baseUrl || providerConfig.headers || providerConfig.apiKey || providerConfig.compat) {
					overrides.set(providerName, {
						baseUrl: providerConfig.baseUrl,
						headers: providerConfig.headers,
						apiKey: providerConfig.apiKey,
						compat: providerConfig.compat,
					});
				}

				// Store API key for fallback resolver.
				if (providerConfig.apiKey) {
					this.customProviderApiKeys.set(providerName, providerConfig.apiKey);
				}

				if (providerConfig.modelOverrides) {
					modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
				}
			}

			return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
		} catch (error) {
			if (error instanceof SyntaxError) {
				return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
			}
			return emptyCustomModelsResult(
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
			);
		}
	}

	private validateConfig(config: ModelsConfig): void {
		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const hasProviderApi = !!providerConfig.api;
			const models = providerConfig.models ?? [];
			const hasModelOverrides =
				providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

			if (models.length === 0) {
				// Override-only config: needs baseUrl, compat, modelOverrides, or some combination.
				if (!providerConfig.baseUrl && !providerConfig.compat && !hasModelOverrides) {
					throw new Error(
						`Provider ${providerName}: must specify "baseUrl", "compat", "modelOverrides", or "models".`,
					);
				}
			} else {
				// Custom models are merged into provider models and require endpoint + auth.
				if (!providerConfig.baseUrl) {
					throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
				}
				if (!providerConfig.apiKey) {
					throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
				}
			}

			for (const modelDef of models) {
				const hasModelApi = !!modelDef.api;

				if (!hasProviderApi && !hasModelApi) {
					throw new Error(
						`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
					);
				}

				if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
				// Validate contextWindow/maxTokens only if provided (they have defaults)
				if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
				if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}

	private parseModels(config: ModelsConfig): Model<Api>[] {
		const models: Model<Api>[] = [];

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models

			// Store API key config for fallback resolver
			if (providerConfig.apiKey) {
				this.customProviderApiKeys.set(providerName, providerConfig.apiKey);
			}

			for (const modelDef of modelDefs) {
				const api = modelDef.api || providerConfig.api;
				if (!api) continue;

				// Merge headers: provider headers are base, model headers override
				// Resolve env vars and shell commands in header values
				const providerHeaders = resolveHeaders(providerConfig.headers);
				const modelHeaders = resolveHeaders(modelDef.headers);
				const compat = mergeCompat(providerConfig.compat, modelDef.compat);
				let headers = providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : undefined;

				// If authHeader is true, add Authorization header with resolved API key
				if (providerConfig.authHeader && providerConfig.apiKey) {
					const resolvedKey = resolveConfigValue(providerConfig.apiKey);
					if (resolvedKey) {
						headers = { ...headers, Authorization: `Bearer ${resolvedKey}` };
					}
				}

				// Provider baseUrl is required when custom models are defined.
				// Individual models can override it with modelDef.baseUrl.
				const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				models.push({
					id: modelDef.id,
					name: modelDef.name ?? modelDef.id,
					api: api as Api,
					provider: providerName,
					baseUrl: modelDef.baseUrl ?? providerConfig.baseUrl!,
					reasoning: modelDef.reasoning ?? false,
					input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
					cost: modelDef.cost ?? defaultCost,
					contextWindow: modelDef.contextWindow ?? 128000,
					maxTokens: modelDef.maxTokens ?? 16384,
					headers,
					compat,
				} as Model<Api>);
			}
		}

		return models;
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.models;
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.models.filter((m) => this.authStorage.hasAuth(m.provider));
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	/**
	 * Get API key for a model.
	 */
	async getApiKey(model: Model<Api>): Promise<string | undefined> {
		return this.authStorage.getApiKey(model.provider);
	}

	/**
	 * Get API key for a provider.
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		return this.authStorage.getApiKey(provider);
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		const cred = this.authStorage.get(model.provider);
		return cred?.type === "oauth";
	}

	/**
	 * Register a provider dynamically (from extensions).
	 *
	 * If provider has models: replaces all existing models for this provider.
	 * If provider has only baseUrl/headers: overrides existing models' URLs.
	 * If provider has oauth: registers OAuth provider for /login support.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		this.validateProviderConfig(providerName, config);
		this.applyProviderConfig(providerName, config);
		this.registeredProviders.set(providerName, config);
	}

	/**
	 * Unregister a previously registered provider.
	 *
	 * Removes the provider from the registry and reloads models from disk so that
	 * built-in models overridden by this provider are restored to their original state.
	 * Also resets dynamic OAuth and API stream registrations before reapplying
	 * remaining dynamic providers.
	 * Has no effect if the provider was never registered.
	 */
	unregisterProvider(providerName: string): void {
		if (!this.registeredProviders.has(providerName)) return;
		this.registeredProviders.delete(providerName);
		this.customProviderApiKeys.delete(providerName);
		this.refresh();
	}

	private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		if (!config.models || config.models.length === 0) {
			return;
		}

		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
		}
		if (!config.apiKey && !config.oauth) {
			throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
		}

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			if (!api) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
			}
		}
	}

	private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
		// Register OAuth provider if provided
		if (config.oauth) {
			// Ensure the OAuth provider ID matches the provider name
			const oauthProvider: OAuthProviderInterface = {
				...config.oauth,
				id: providerName,
			};
			registerOAuthProvider(oauthProvider);
		}

		if (config.streamSimple) {
			const streamSimple = config.streamSimple;
			registerApiProvider(
				{
					api: config.api!,
					stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
					streamSimple,
				},
				`provider:${providerName}`,
			);
		}

		// Store API key for auth resolution
		if (config.apiKey) {
			this.customProviderApiKeys.set(providerName, config.apiKey);
		}

		if (config.models && config.models.length > 0) {
			// Full replacement: remove existing models for this provider
			this.models = this.models.filter((m) => m.provider !== providerName);

			// Parse and add new models
			for (const modelDef of config.models) {
				const api = modelDef.api || config.api;

				// Merge headers
				const providerHeaders = resolveHeaders(config.headers);
				const modelHeaders = resolveHeaders(modelDef.headers);
				let headers = providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : undefined;

				// If authHeader is true, add Authorization header
				if (config.authHeader && config.apiKey) {
					const resolvedKey = resolveConfigValue(config.apiKey);
					if (resolvedKey) {
						headers = { ...headers, Authorization: `Bearer ${resolvedKey}` };
					}
				}

				this.models.push({
					id: modelDef.id,
					name: modelDef.name,
					api: api as Api,
					provider: providerName,
					baseUrl: config.baseUrl!,
					reasoning: modelDef.reasoning,
					input: modelDef.input as ("text" | "image")[],
					cost: modelDef.cost,
					contextWindow: modelDef.contextWindow,
					maxTokens: modelDef.maxTokens,
					headers,
					compat: modelDef.compat,
				} as Model<Api>);
			}

			// Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl)
			if (config.oauth?.modifyModels) {
				const cred = this.authStorage.get(providerName);
				if (cred?.type === "oauth") {
					this.models = config.oauth.modifyModels(this.models, cred);
				}
			}
		} else if (config.baseUrl) {
			// Override-only: update baseUrl/headers for existing models
			const resolvedHeaders = resolveHeaders(config.headers);
			this.models = this.models.map((m) => {
				if (m.provider !== providerName) return m;
				return {
					...m,
					baseUrl: config.baseUrl ?? m.baseUrl,
					headers: resolvedHeaders ? { ...m.headers, ...resolvedHeaders } : m.headers,
				};
			});
		}
	}
}

/**
 * Input type for registerProvider API.
 */
export interface ProviderConfigInput {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	/** OAuth provider for /login support */
	oauth?: Omit<OAuthProviderInterface, "id">;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
}
