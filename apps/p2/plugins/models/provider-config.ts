// models.json composition adapted from earendil-works/pi provider-composer.ts
// (MIT); see third-party/pi.LICENSE. Extension compatibility is intentionally omitted.
import {
	type AnyModel,
	type Api,
	type ApiKeyAuth,
	type AuthResult,
	isModelType,
	type Model,
	type ModelAuth,
	type Provider,
	type ProviderHeaders,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./config-value.ts";
import type { ModelConfig, ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "./model-config.ts";

function mergeHeaders(...sources: (ProviderHeaders | undefined)[]): ProviderHeaders | undefined {
	const headers = new Map<string, [string, string | null]>();
	for (const source of sources)
		for (const [name, value] of Object.entries(source ?? {})) headers.set(name.toLowerCase(), [name, value]);
	return headers.size ? Object.fromEntries(headers.values()) : undefined;
}

function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	return merged;
}

function mergeInputLimits(
	base: Model<Api>["inputLimits"],
	override: ModelsJsonModelOverride["inputLimits"],
): Model<Api>["inputLimits"] {
	if (!override) return base;
	return {
		...base,
		...override,
		images: override.images
			? {
					...base?.images,
					...override.images,
					resize: override.images.resize
						? { ...base?.images?.resize, ...override.images.resize }
						: base?.images?.resize,
				}
			: base?.images,
	};
}

function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		compat: mergeCompat(model.compat, override.compat),
	};
}

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
): Model<Api> {
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: api as Api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		input: (definition.input ?? ["text"]) as ("text" | "image")[],
		inputLimits: definition.inputLimits,
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		promptCache: definition.promptCache,
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		samplingParams: definition.samplingParams,
		headers: undefined,
		compat: mergeCompat(providerConfig.compat, definition.compat),
	};
}

function findModelDefaults(models: readonly AnyModel[], modelId: string, api?: Api): Model<Api> | undefined {
	const chatModels = models.filter((model) => isModelType(model, "chat"));
	return (
		chatModels.find((model) => model.id === modelId) ??
		(api ? chatModels.find((model) => model.api === api) : undefined) ??
		chatModels.find((model) => model.api === "openai-completions") ??
		chatModels[0]
	);
}

function applyModelsJson(
	providerId: string,
	baseModels: readonly AnyModel[],
	config: ModelsJsonProvider | undefined,
): AnyModel[] {
	if (!config) return [...baseModels];
	if (config.oauth && !config.baseUrl) {
		throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
	}
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.headers &&
		!config.compat &&
		!hasOverrides &&
		!config.apiKey &&
		!config.oauth &&
		config.authHeader === undefined
	) {
		throw new Error(
			`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
		);
	}

	const models: AnyModel[] = baseModels.map((model) => {
		const baseUrl = config.oauth === "radius" ? model.baseUrl : (config.baseUrl ?? model.baseUrl);
		return isModelType(model, "chat")
			? { ...model, baseUrl, compat: mergeCompat(model.compat, config.compat) }
			: { ...model, baseUrl };
	});
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => isModelType(model, "chat") && model.id === definition.id);
		const defaults = findModelDefaults(models, definition.id, definition.api ?? config.api);
		const model = modelFromJson(providerId, definition, config, defaults);
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	return models;
}

function withConfiguredAuth(
	auth: ModelAuth,
	headers: Record<string, string> | undefined,
	authHeader: boolean,
): ModelAuth {
	let mergedHeaders: ProviderHeaders | undefined = mergeHeaders(auth.headers, headers);
	if (authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, headers: mergedHeaders };
}

const apis = new Map<string, () => ProviderStreams>([
	["openai-completions", openAICompletionsApi],
	["openai-responses", openAIResponsesApi],
	["anthropic-messages", anthropicMessagesApi],
	["google-generative-ai", googleGenerativeAIApi],
]);

function composeProvider(id: string, base: Provider | undefined, config: ModelsJsonProvider): Provider {
	if (config.oauth) throw new Error("Custom OAuth catalogs are not supported; use a built-in OAuth provider");
	const buildModels = () =>
		applyModelsJson(id, base?.getAllModels?.() ?? base?.getModels() ?? [], config).map((model) => {
			const override = config.modelOverrides?.[model.id];
			return override && isModelType(model, "chat") ? applyModelOverride(model, override) : model;
		});
	const models = buildModels();
	const implementations = new Map<string, ProviderStreams>();
	for (const model of models.filter((model) => isModelType(model, "chat"))) {
		const inherited = base?.getModels().some((entry) => entry.api === model.api);
		const implementation = inherited ? base : apis.get(model.api)?.();
		if (!implementation) throw new Error("Unsupported custom model API");
		implementations.set(model.api, implementation);
	}
	const inherited = base?.auth.apiKey;
	const apiKey: ApiKeyAuth | undefined =
		!inherited && config.apiKey === undefined && base?.auth.oauth
			? undefined
			: {
					name: inherited?.name ?? "API key",
					login:
						inherited?.login ??
						(async (interaction) => ({
							type: "api_key",
							key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
						})),
					check: async (input) => {
						if (input.credential)
							return inherited?.check
								? inherited.check(input)
								: { type: "api_key", source: "stored credential" };
						if (config.apiKey !== undefined) {
							if (isCommandConfigValue(config.apiKey)) return { type: "api_key", source: "configured API key" };
							for (const name of getConfigValueEnvVarNames(config.apiKey))
								if ((await input.ctx.env(name)) === undefined) return undefined;
							return { type: "api_key", source: "configured API key" };
						}
						return inherited?.check
							? inherited.check(input)
							: inherited
								? (await inherited.resolve(input))
									? { type: "api_key" }
									: undefined
								: { type: "api_key", source: "local" };
					},
					resolve: async (input) => {
						let result: AuthResult | undefined;
						if (input.credential)
							result = inherited
								? await inherited.resolve(input)
								: {
										auth: { apiKey: input.credential.key },
										env: input.credential.env,
										source: "stored credential",
									};
						else if (config.apiKey !== undefined) {
							const env: Record<string, string> = {};
							for (const name of getConfigValueEnvVarNames(config.apiKey)) {
								const value = await input.ctx.env(name);
								if (value !== undefined) env[name] = value;
							}
							const key = resolveConfigValueOrThrow(config.apiKey, "configured API key", env);
							result = inherited
								? await inherited.resolve({ ...input, credential: { type: "api_key", key } })
								: { auth: { apiKey: key }, source: "configured API key" };
						} else result = inherited ? await inherited.resolve(input) : { auth: {}, source: "local" };
						if (!result) return undefined;
						const env = { ...input.credential?.env, ...result.env };
						for (const raw of Object.values(config.headers ?? {}))
							for (const name of getConfigValueEnvVarNames(raw)) {
								if (env[name] !== undefined) continue;
								const value = await input.ctx.env(name);
								if (value !== undefined) env[name] = value;
							}
						return {
							...result,
							auth: withConfiguredAuth(
								result.auth,
								resolveHeadersOrThrow(config.headers, "configured provider", env),
								config.authHeader ?? false,
							),
						};
					},
				};
	const oauth = base?.auth.oauth;
	return {
		...base,
		id,
		name: config.name ?? base?.name ?? id,
		baseUrl: config.baseUrl ?? base?.baseUrl,
		auth: {
			...(apiKey ? { apiKey } : {}),
			...(oauth
				? {
						oauth: {
							...oauth,
							toAuth: async (credential) => {
								const auth = await oauth.toAuth(credential);
								return withConfiguredAuth(
									auth,
									resolveHeadersOrThrow(
										config.headers,
										"configured provider",
										credential.env as Record<string, string> | undefined,
									),
									config.authHeader ?? false,
								);
							},
						},
					}
				: {}),
		},
		getModels: () => buildModels().filter((model) => isModelType(model, "chat")),
		getAllModels: buildModels,
		stream: (model, context, options) => {
			const api = implementations.get(model.api);
			if (!api) throw new Error("Unavailable model API");
			return api.stream(model, context, options);
		},
		streamSimple: (model, context, options) => {
			const api = implementations.get(model.api);
			if (!api) throw new Error("Unavailable model API");
			return api.streamSimple(model, context, options);
		},
	};
}

export function applyModelConfig(models: MutableModels, config: ModelConfig): void {
	for (const id of config.getProviderIds()) {
		const provider = config.getProvider(id);
		if (provider) models.setProvider(composeProvider(id, models.getProvider(id), provider));
	}
	// Models calls getAuth for every request. Resolve model-specific headers here,
	// before explicit request headers and transformHeaders, not after provider dispatch.
	const original = models.getAuth.bind(models);
	models.getAuth = async (input, overrides) => {
		const result = typeof input === "string" ? await original(input, overrides) : await original(input, overrides);
		if (!result || typeof input === "string" || !isModelType(input, "chat")) return result;
		const provider = config.getProvider(input.provider);
		const raw = {
			...provider?.models?.find((model) => model.id === input.id)?.headers,
			...provider?.modelOverrides?.[input.id]?.headers,
		};
		const headers = resolveHeadersOrThrow(raw, "configured model", { ...result.env, ...overrides?.env });
		return { ...result, auth: { ...result.auth, headers: mergeHeaders(result.auth.headers, headers) } };
	};
}
