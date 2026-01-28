import { type Api, getApiKey, getModels, getProviders, type KnownProvider, type Model } from "@kennyfrc/mu-ai";
import { type Static, Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
	getOAuthApiKey,
	getOAuthProviderForModelProvider,
	loadOAuthCredentials,
} from "../../ai/src/utils/oauth/index.js";

// Handle both default and named exports
const Ajv = (AjvModule as any).default || AjvModule;

// Schema for custom model definition
const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	api: Type.Optional(
		Type.Union([
			Type.Literal("openai-completions"),
			Type.Literal("openai-responses"),
			Type.Literal("anthropic-messages"),
			Type.Literal("google-generative-ai"),
			Type.Literal("zai-completions"),
		]),
	),
	reasoning: Type.Boolean(),
	reasoningFormat: Type.Optional(Type.Union([Type.Literal("think_tags"), Type.Literal("reasoning_content")])),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	cost: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
	}),
	contextWindow: Type.Number(),
	maxTokens: Type.Number(),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const ProviderConfigSchema = Type.Object({
	baseUrl: Type.String({ minLength: 1 }),
	apiKey: Type.String({ minLength: 1 }),
	api: Type.Optional(
		Type.Union([
			Type.Literal("openai-completions"),
			Type.Literal("openai-responses"),
			Type.Literal("anthropic-messages"),
			Type.Literal("google-generative-ai"),
			Type.Literal("zai-completions"),
		]),
	),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	models: Type.Array(ModelDefinitionSchema),
});

const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema),
});

type ModelsConfig = Static<typeof ModelsConfigSchema>;
type ProviderConfig = Static<typeof ProviderConfigSchema>;
type ModelDefinition = Static<typeof ModelDefinitionSchema>;

// Custom provider API key mappings (provider name -> apiKey config)
const customProviderApiKeys: Map<string, string> = new Map();

/**
 * Resolve an API key config value to an actual key.
 * First checks if it's an environment variable, then treats as literal.
 */
export function resolveApiKey(keyConfig: string): string | undefined {
	// First check if it's an env var name
	const envValue = process.env[keyConfig];
	if (envValue) return envValue;

	// Otherwise treat as literal API key
	return keyConfig;
}

/**
 * Load custom models from ~/.mu/agent/models.json
 * Returns { models, error } - either models array or error message
 */
function loadCustomModels(): { models: Model<Api>[]; error: string | null } {
	const configPath = join(homedir(), ".mu", "agent", "models.json");
	if (!existsSync(configPath)) {
		return { models: [], error: null };
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const config: ModelsConfig = JSON.parse(content);

		// Validate schema
		const ajv = new Ajv();
		const validate = ajv.compile(ModelsConfigSchema);
		if (!validate(config)) {
			const errors =
				validate.errors?.map((e: any) => `  - ${e.instancePath || "root"}: ${e.message}`).join("\n") ||
				"Unknown schema error";
			return {
				models: [],
				error: `Invalid models.json schema:\n${errors}\n\nFile: ${configPath}`,
			};
		}

		// Additional validation
		try {
			validateConfig(config);
		} catch (error) {
			return {
				models: [],
				error: `Invalid models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${configPath}`,
			};
		}

		// Parse models
		return { models: parseModels(config), error: null };
	} catch (error) {
		if (error instanceof SyntaxError) {
			return {
				models: [],
				error: `Failed to parse models.json: ${error.message}\n\nFile: ${configPath}`,
			};
		}
		return {
			models: [],
			error: `Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${configPath}`,
		};
	}
}

/**
 * Validate config structure and requirements
 */
function validateConfig(config: ModelsConfig): void {
	for (const [providerName, providerConfig] of Object.entries(config.providers)) {
		const hasProviderApi = !!providerConfig.api;

		for (const modelDef of providerConfig.models) {
			const hasModelApi = !!modelDef.api;

			if (!hasProviderApi && !hasModelApi) {
				throw new Error(
					`Provider ${providerName}, model ${modelDef.id}: no "api" specified. ` +
						`Set at provider or model level.`,
				);
			}

			// Validate required fields
			if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
			if (!modelDef.name) throw new Error(`Provider ${providerName}: model missing "name"`);
			if (modelDef.contextWindow <= 0)
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
			if (modelDef.maxTokens <= 0)
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
		}
	}
}

/**
 * Parse config into Model objects
 */
function parseModels(config: ModelsConfig): Model<Api>[] {
	const models: Model<Api>[] = [];

	// Clear and rebuild custom provider API key mappings
	customProviderApiKeys.clear();

	for (const [providerName, providerConfig] of Object.entries(config.providers)) {
		// Store API key config for this provider
		customProviderApiKeys.set(providerName, providerConfig.apiKey);

		for (const modelDef of providerConfig.models) {
			// Model-level api overrides provider-level api
			const api = modelDef.api || providerConfig.api;

			if (!api) {
				// This should have been caught by validateConfig, but be safe
				continue;
			}

			// Merge headers: provider headers are base, model headers override
			const headers =
				providerConfig.headers || modelDef.headers ? { ...providerConfig.headers, ...modelDef.headers } : undefined;

			models.push({
				id: modelDef.id,
				name: modelDef.name,
				api: api as Api,
				provider: providerName,
				baseUrl: providerConfig.baseUrl,
				reasoning: modelDef.reasoning,
				input: modelDef.input as ("text" | "image")[],
				cost: modelDef.cost,
				contextWindow: modelDef.contextWindow,
				maxTokens: modelDef.maxTokens,
				headers,
				// Only include optional properties if they exist in modelDef
				...(modelDef.reasoningFormat && { reasoningFormat: modelDef.reasoningFormat }),
				...(modelDef.extraBody && { extraBody: modelDef.extraBody }),
			});
		}
	}

	return models;
}

/**
 * Get all models (built-in + custom), freshly loaded
 * Returns { models, error } - either models array or error message
 */
export function loadAndMergeModels(): { models: Model<Api>[]; error: string | null } {
	const builtInModels: Model<Api>[] = [];
	const providers = getProviders();

	// Load all built-in models
	for (const provider of providers) {
		const providerModels = getModels(provider as KnownProvider);
		builtInModels.push(...(providerModels as Model<Api>[]));
	}

	// Load custom models
	const { models: customModels, error } = loadCustomModels();

	if (error) {
		return { models: [], error };
	}

	// Merge: custom models come after built-in.
	// If a custom model has the same (provider,id) as a built-in model, de-duplicate so it only shows once
	// in the model selector. This also allows users to override built-in models via models.json.
	const keyOf = (m: Model<Api>) => `${m.provider}:${m.id}`;
	const customKeys = new Set(customModels.map(keyOf));
	const dedupedBuiltIn = builtInModels.filter((m) => !customKeys.has(keyOf(m)));
	return { models: [...dedupedBuiltIn, ...customModels], error: null };
}

/**
 * Get API key for a model (checks custom providers first, then built-in)
 * Now async to support OAuth token refresh.
 *
 * For Anthropic: OAuth is REQUIRED. Will throw if OAuth is unavailable.
 * Use --api-key flag to explicitly bypass OAuth enforcement.
 */
export async function getApiKeyForModel(model: Model<Api>): Promise<string | undefined> {
	// For custom providers, check their apiKey config
	const customKeyConfig = customProviderApiKeys.get(model.provider);
	if (customKeyConfig) {
		return resolveApiKey(customKeyConfig);
	}

	// For OAuth providers (Anthropic, Google Gemini CLI, Antigravity, GitHub Copilot)
	// Check OAuth storage (auto-refresh if needed)
	const oauthProvider = getOAuthProviderForModelProvider(model.provider);

	// Anthropic: OAuth is MANDATORY - no fallback to ANTHROPIC_API_KEY env var
	if (model.provider === "anthropic") {
		const hasStoredCreds = oauthProvider ? !!loadOAuthCredentials(oauthProvider) : false;

		// Try stored OAuth credentials (auto-refresh if needed)
		if (oauthProvider) {
			const oauthKey = await getOAuthApiKey(oauthProvider);
			if (oauthKey) {
				return oauthKey;
			}
		}

		// Try manual OAuth token from env var
		const oauthEnv = process.env.ANTHROPIC_OAUTH_TOKEN;
		if (oauthEnv) {
			return oauthEnv;
		}

		// No OAuth available - throw actionable error (no silent fallback to API key)
		if (!hasStoredCreds) {
			throw new Error(
				'Anthropic requires OAuth. Run "mu" then "/login" and select Anthropic.\n' +
					"Or pass --api-key explicitly to use an API key.",
			);
		}
		// Had stored creds but refresh/resolve failed
		throw new Error(
			'Anthropic OAuth credentials expired or invalid. Run "/login" again.\n' +
				"Or pass --api-key explicitly to bypass OAuth.",
		);
	}

	// For other OAuth providers (non-Anthropic), try OAuth first then fall back to env vars
	if (oauthProvider) {
		const oauthKey = await getOAuthApiKey(oauthProvider);
		if (oauthKey) {
			return oauthKey;
		}
	}

	// For built-in providers, use getApiKey from @kennyfrc/mu-ai
	return getApiKey(model.provider as KnownProvider);
}

/**
 * Get only models that have valid API keys available
 * Returns { models, error } - either models array or error message
 */
export async function getAvailableModels(): Promise<{ models: Model<Api>[]; error: string | null }> {
	const { models: allModels, error } = loadAndMergeModels();

	if (error) {
		return { models: [], error };
	}

	const availableModels: Model<Api>[] = [];
	for (const model of allModels) {
		const apiKey = await getApiKeyForModel(model);
		if (apiKey) {
			availableModels.push(model);
		}
	}

	return { models: availableModels, error: null };
}

/**
 * Find a specific model by provider and ID
 * Returns { model, error } - either model or error message
 */
export function findModel(provider: string, modelId: string): { model: Model<Api> | null; error: string | null } {
	const { models: allModels, error } = loadAndMergeModels();

	if (error) {
		return { model: null, error };
	}

	const model = allModels.find((m) => m.provider === provider && m.id === modelId) || null;
	return { model, error: null };
}

/**
 * Mapping from model provider to OAuth provider ID.
 * Only providers that support OAuth are listed here.
 */
const providerToOAuthProvider: Record<string, string> = {
	anthropic: "anthropic",
	"github-copilot": "github-copilot",
	"google-gemini-cli": "google-gemini-cli",
	"google-antigravity": "google-antigravity",
	"openai-codex": "openai-codex",
};

// Cache for OAuth status per provider (avoids file reads on every render)
const oauthStatusCache: Map<string, boolean> = new Map();

/**
 * Invalidate the OAuth status cache.
 * Call this after login/logout operations.
 */
export function invalidateOAuthCache(): void {
	oauthStatusCache.clear();
}

/**
 * Check if a model is using OAuth credentials (subscription).
 * This checks if OAuth credentials exist and would be used for the model,
 * without actually fetching or refreshing the token.
 * Results are cached until invalidateOAuthCache() is called.
 */
export function isModelUsingOAuth(model: Model<Api>): boolean {
	const oauthProvider = providerToOAuthProvider[model.provider];
	if (!oauthProvider) {
		return false;
	}

	// Check cache first
	if (oauthStatusCache.has(oauthProvider)) {
		return oauthStatusCache.get(oauthProvider)!;
	}

	// Check if OAuth credentials exist for this provider
	let usingOAuth = false;
	const credentials = loadOAuthCredentials(oauthProvider);
	if (credentials) {
		usingOAuth = true;
	}

	// Also check for manual OAuth token env var (for Anthropic)
	if (!usingOAuth && model.provider === "anthropic" && process.env.ANTHROPIC_OAUTH_TOKEN) {
		usingOAuth = true;
	}

	oauthStatusCache.set(oauthProvider, usingOAuth);
	return usingOAuth;
}
