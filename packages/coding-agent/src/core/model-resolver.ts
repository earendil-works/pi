/**
 * Model resolution, scoping, and initial selection
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AuthOperationOptions,
	type KnownProvider,
	type Model,
	modelsAreEqual,
} from "@earendil-works/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRuntime } from "./model-runtime.ts";

/** Default chat model IDs for providers with built-in chat models. */
export const defaultModelPerProvider: Partial<Record<KnownProvider, string>> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-4-8",
	openai: "gpt-6.1-sol",
	azure: "gpt-5.4",
	"openai-codex": "gpt-6.1-sol",
	radius: "balanced",
	nvidia: "nvidia/nemotron-3.5-super-vl-120b-a12b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-6.1-sol",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.7",
	groq: "openai/gpt-oss-120b",
	cerebras: "gpt-oss-120b",
	zai: "glm-5.3",
	"zai-coding-cn": "glm-5.3",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k3",
	together: "moonshotai/Kimi-K3",
	baseten: "zai-org/GLM-5.2",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k3",
	"kimi-coding": "kimi-for-coding",
	meta: "muse-spark-1.3",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	"qwen-token-plan-individual": "qwen3.8-max",
	xiaomi: "mimo-v2.6-pro",
	"xiaomi-token-plan-cn": "mimo-v2.6-pro",
	"xiaomi-token-plan-ams": "mimo-v2.6-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.6-pro",
};

export interface ScopedModel {
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	thinkingLevel?: ThinkingLevel;
}

/*
 * Model reference resolution. Candidates are collected before a provider is chosen, so catalog order
 * never decides the provider and an ambiguous match is reported instead of falling through to a
 * weaker one.
 */

export interface ModelReferenceRequest {
	/** Bare model id or `provider/id`, optionally followed by `:<thinking>`. */
	text: string;
	/** Only consider models from this provider. */
	provider?: string;
	/**
	 * A trailing `:<suffix>` is only considered when the full text matches no model, since ids such as
	 * OpenRouter's `qwen/qwen3-coder:exacto` contain colons.
	 * - `none`: the suffix stays part of the id
	 * - `strict`: a valid thinking level is parsed; any other suffix stays part of the id
	 * - `lenient`: like `strict`, but an invalid suffix is dropped with a warning
	 */
	thinkingSuffix: "none" | "strict" | "lenient";
	/** Match id and name substrings when no exact match exists. */
	fuzzy: boolean;
}

export type ModelReferenceResult =
	| { status: "resolved"; model: Model<Api>; thinkingLevel?: ThinkingLevel; warning?: string }
	| {
			status: "ambiguous";
			candidates: Model<Api>[];
			usableCount: number;
			thinkingLevel?: ThinkingLevel;
			warning?: string;
	  }
	| {
			status: "not-found";
			/** Set when a provider is explicit or named by a `provider/` prefix, for building a custom model id. */
			target?: ModelReferenceTarget;
	  };

export interface ModelReferenceTarget {
	provider: string;
	providerModels: [Model<Api>, ...Model<Api>[]];
	/** Text after the provider prefix as typed, including any `:<suffix>`. */
	modelText: string;
	/** `modelText` without a valid thinking suffix (unless `thinkingSuffix` is `none`). */
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

type ResolvedOrAmbiguous = Exclude<ModelReferenceResult, { status: "not-found" }>;

function splitThinkingSuffix(text: string): { base: string; thinkingLevel: ThinkingLevel } | undefined {
	const colonIndex = text.lastIndexOf(":");
	const suffix = text.substring(colonIndex + 1);
	if (colonIndex === -1 || !isValidThinkingLevel(suffix)) return undefined;
	return { base: text.substring(0, colonIndex), thinkingLevel: suffix };
}

function splitProviderPrefix(
	text: string,
	models: readonly Model<Api>[],
): { provider: string; modelText: string } | undefined {
	// Provider ids may contain "/" themselves (e.g. URL-derived ids), so match known ids, longest first
	const lowerText = text.toLowerCase();
	let best: { provider: string; modelText: string } | undefined;
	for (const { provider } of models) {
		const prefix = provider.trim().toLowerCase();
		if (!prefix || (best && best.provider.length >= provider.length)) continue;
		const slashIndex = lowerText.indexOf("/", prefix.length);
		if (slashIndex === -1 || lowerText.substring(0, slashIndex).trim() !== prefix) continue;
		const modelText = text.substring(slashIndex + 1).trim();
		if (modelText) best = { provider, modelText };
	}
	return best;
}

/**
 * `usable` only breaks ties between providers, so a unique match resolves even without credentials
 * (`--api-key` first-time setup).
 */
export function resolveModelReference(
	request: ModelReferenceRequest,
	models: readonly Model<Api>[],
	usable: (provider: string) => boolean,
): ModelReferenceResult {
	const text = request.text.trim();
	if (!text) return { status: "not-found" };
	const constraint = request.provider?.toLowerCase();
	const pool = constraint ? models.filter((model) => model.provider.toLowerCase() === constraint) : models;
	const result = resolveText(text, request, pool, usable);
	if (result.status !== "not-found") return result;

	const split = splitProviderPrefix(text, pool);
	const anchor = constraint ? pool[0] : pool.find((model) => model.provider === split?.provider);
	if (!anchor) return result;
	const modelText = split?.modelText ?? text;
	const suffix = request.thinkingSuffix === "none" ? undefined : splitThinkingSuffix(modelText);
	return {
		status: "not-found",
		target: {
			provider: anchor.provider,
			providerModels: [anchor, ...pool.filter((model) => model.provider === anchor.provider && model !== anchor)],
			modelText,
			modelId: suffix?.base ?? modelText,
			thinkingLevel: suffix?.thinkingLevel,
		},
	};
}

/** Exact `provider/id` or bare id lookup without thinking suffixes or fuzzy matching. */
export function findExactModelReferenceMatch(
	modelReference: string,
	models: readonly Model<Api>[],
): Model<Api> | undefined {
	const result = resolveModelReference(
		{ text: modelReference, thinkingSuffix: "none", fuzzy: false },
		models,
		() => true,
	);
	return result.status === "resolved" ? result.model : undefined;
}

function resolveText(
	text: string,
	request: ModelReferenceRequest,
	pool: readonly Model<Api>[],
	usable: (provider: string) => boolean,
): ModelReferenceResult {
	const reference = selectReference(text, pool, request.fuzzy, usable);
	if (reference) return reference;

	if (request.fuzzy) {
		const fuzzy = selectFuzzy(fuzzyMatches(text, pool), usable);
		if (fuzzy) return fuzzy;
	}

	if (request.thinkingSuffix === "none") return { status: "not-found" };
	const thinking = splitThinkingSuffix(text);
	if (thinking) {
		const inner = resolveText(thinking.base, request, pool, usable);
		if (inner.status === "not-found") return inner;
		// Only use this thinking level if no warning from inner recursion
		return { ...inner, thinkingLevel: inner.warning ? undefined : thinking.thinkingLevel };
	}
	// Keep an invalid suffix as part of the id and fail, rather than resolve a different model
	if (request.thinkingSuffix === "strict") return { status: "not-found" };
	const colonIndex = text.lastIndexOf(":");
	if (colonIndex === -1) return { status: "not-found" };

	const suffix = text.substring(colonIndex + 1);
	const inner = resolveText(text.substring(0, colonIndex), request, pool, usable);
	if (inner.status === "not-found") return inner;
	return {
		...inner,
		thinkingLevel: undefined,
		warning: `Invalid thinking level "${suffix}" in pattern "${text}". Using default instead.`,
	};
}

/**
 * `provider/rest` is only a hint: the whole text may also be a model id on another provider, such as
 * gateway id `zai/glm-5` or commandcode id `xiaomi/mimo-v2.6-pro`. The named provider wins when usable,
 * since that is what the syntax usually means; otherwise a sole usable raw match wins, since the named
 * provider could not serve the request. An unusable named match is still preferred over unusable raw
 * matches, so `--api-key` can set up the named provider.
 */
function selectReference(
	text: string,
	pool: readonly Model<Api>[],
	fuzzy: boolean,
	usable: (provider: string) => boolean,
): ResolvedOrAmbiguous | undefined {
	const lowerText = text.toLowerCase();
	const raw = pool.filter((model) => model.id.toLowerCase() === lowerText);
	const split = splitProviderPrefix(text, pool);
	let named: Model<Api> | undefined;
	if (split) {
		const providerModels = pool.filter((model) => model.provider === split.provider);
		const lowerModelText = split.modelText.toLowerCase();
		// The provider's own literal id (OpenRouter's `openrouter/free`) beats its fuzzy matches
		named =
			providerModels.find((model) => model.id.toLowerCase() === lowerModelText) ??
			raw.find((model) => model.provider === split.provider) ??
			(fuzzy ? bestFuzzyMatch(fuzzyMatches(split.modelText, providerModels)) : undefined);
	}

	const others = raw.filter((model) => model !== named);
	const candidates = named ? [named, ...others] : others;
	if (candidates.length === 0) return undefined;
	if (new Set(candidates.map((model) => model.provider)).size === 1)
		return { status: "resolved", model: candidates[0] };
	if (named && usable(named.provider)) return { status: "resolved", model: named };
	const usableOthers = others.filter((model) => usable(model.provider));
	if (usableOthers.length === 1) return { status: "resolved", model: usableOthers[0] };
	if (usableOthers.length === 0 && named) return { status: "resolved", model: named };
	return { status: "ambiguous", candidates, usableCount: usableOthers.length };
}

function fuzzyMatches(text: string, models: readonly Model<Api>[]): Model<Api>[] {
	const lowerText = text.toLowerCase();
	return models.filter(
		(model) => model.id.toLowerCase().includes(lowerText) || model.name?.toLowerCase().includes(lowerText),
	);
}

function selectFuzzy(matches: Model<Api>[], usable: (provider: string) => boolean): ResolvedOrAmbiguous | undefined {
	if (matches.length === 0) return undefined;
	const multipleProviders = new Set(matches.map((model) => model.provider)).size > 1;
	const usableMatches = multipleProviders ? matches.filter((model) => usable(model.provider)) : [];
	const pool = usableMatches.length > 0 ? usableMatches : matches;
	const best = bestFuzzyMatch(pool);
	if (!best) return undefined;
	// The same id on several providers would otherwise be decided by catalog order
	const tied = pool.filter((model) => model.id === best.id);
	if (new Set(tied.map((model) => model.provider)).size === 1) return { status: "resolved", model: best };
	return {
		status: "ambiguous",
		candidates: tied,
		usableCount: usableMatches.length > 0 ? tied.length : 0,
	};
}

/** Prefer aliases (`claude-sonnet-4-5`) over dated versions (`claude-sonnet-4-5-20250929`), then the latest. */
function bestFuzzyMatch(matches: readonly Model<Api>[]): Model<Api> | undefined {
	const aliases = matches.filter((model) => isAlias(model.id));
	return [...(aliases.length > 0 ? aliases : matches)].sort((a, b) => b.id.localeCompare(a.id))[0];
}

function isAlias(id: string): boolean {
	return id.endsWith("-latest") || !/-\d{8}$/.test(id);
}

function buildFallbackModel(providerModels: [Model<Api>, ...Model<Api>[]], modelId: string): Model<Api> {
	const defaultId = defaultModelPerProvider[providerModels[0].provider as KnownProvider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

export interface ModelScopeDiagnostic {
	type: "warning";
	code: "no-match" | "invalid-thinking-level" | "ambiguous";
	message: string;
	pattern: string;
}

export interface ResolveModelScopeResult {
	scopedModels: ScopedModel[];
	diagnostics: ModelScopeDiagnostic[];
}

/**
 * Resolve scope patterns (`--models`, `enabledModels`) to models with optional thinking levels.
 *
 * Every model in `models` is usable, so credentials cannot choose between providers offering the same
 * id. All of them are added, with a warning so the user can pick one with `provider/id`.
 */
export function resolveModelScopeFromModels(
	patterns: string[],
	models: readonly Model<Api>[],
): ResolveModelScopeResult {
	const scopedModels: ScopedModel[] = [];
	const diagnostics: ModelScopeDiagnostic[] = [];
	const add = (model: Model<Api>, thinkingLevel: ThinkingLevel | undefined) => {
		if (!scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	};
	const noMatch = (pattern: string) =>
		diagnostics.push({ type: "warning", code: "no-match", message: `No models match pattern "${pattern}"`, pattern });
	const ambiguous = (pattern: string, candidates: readonly Model<Api>[]) => {
		const providers = [...new Set(candidates.map((m) => m.provider))].sort((a, b) => a.localeCompare(b));
		diagnostics.push({
			type: "warning",
			code: "ambiguous",
			message: `Pattern "${pattern}" matches several providers: ${providers.join(", ")}. Use provider/id to choose one.`,
			pattern,
		});
	};

	for (const pattern of patterns) {
		// Check if pattern contains glob characters
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// Extract optional thinking level suffix (e.g., "provider/*:high")
			const thinking = splitThinkingSuffix(pattern);
			const globPattern = thinking?.base ?? pattern;
			const thinkingLevel = thinking?.thinkingLevel;

			// Ids such as `bracketed-model[1m]` are not globs
			const exact = resolveModelReference(
				{ text: globPattern, thinkingSuffix: "none", fuzzy: false },
				models,
				() => true,
			);
			let matches: readonly Model<Api>[] = [];
			if (exact.status === "resolved") matches = [exact.model];
			else if (exact.status === "ambiguous") {
				matches = exact.candidates;
				ambiguous(pattern, matches);
			} else {
				// Match against "provider/modelId" format OR just model ID
				// This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
				matches = models.filter(
					(m) =>
						minimatch(`${m.provider}/${m.id}`, globPattern, { nocase: true }) ||
						minimatch(m.id, globPattern, { nocase: true }),
				);
			}
			if (matches.length === 0) noMatch(pattern);
			for (const model of matches) add(model, thinkingLevel);
			continue;
		}

		const result = resolveModelReference(
			{ text: pattern, thinkingSuffix: "lenient", fuzzy: true },
			models,
			() => true,
		);
		if (result.status === "not-found") {
			noMatch(pattern);
			continue;
		}
		if (result.warning) {
			diagnostics.push({ type: "warning", code: "invalid-thinking-level", message: result.warning, pattern });
		}
		if (result.status === "ambiguous") ambiguous(pattern, result.candidates);
		const matches = result.status === "resolved" ? [result.model] : result.candidates;
		for (const model of matches) add(model, result.thinkingLevel);
	}

	return { scopedModels, diagnostics };
}

export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ResolveModelScopeResult> {
	return resolveModelScopeFromModels(patterns, await modelRuntime.getAvailable(undefined, options));
}

export async function resolveModelScope(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ScopedModel[]> {
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime, options);
	for (const diagnostic of diagnostics) {
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}
	return scopedModels;
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * Error message suitable for CLI display.
	 * When set, model will be undefined.
	 */
	error: string | undefined;
}

/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	cliThinking?: ThinkingLevel;
	/** `--api-key` was supplied for the selected provider. */
	inlineApiKey?: boolean;
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, cliThinking, inlineApiKey, modelRuntime } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// Important: use *all* models here, not just models with pre-configured auth.
	// This allows "--api-key" to be used for first-time setup.
	const models = [...modelRuntime.getModels()];
	if (models.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const provider = cliProvider
		? models.find((m) => m.provider.toLowerCase() === cliProvider.toLowerCase())?.provider
		: undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	const result = resolveModelReference(
		{ text: cliModel, provider, thinkingSuffix: "strict", fuzzy: true },
		models,
		// An inline key goes to whichever provider is selected, so stored credentials must not choose it
		inlineApiKey ? () => false : (providerId) => modelRuntime.hasConfiguredAuth(providerId),
	);
	if (result.status === "resolved") {
		return { model: result.model, thinkingLevel: result.thinkingLevel, warning: result.warning, error: undefined };
	}
	if (result.status === "ambiguous") {
		const matches = result.candidates
			.map((m) => `${m.provider}/${m.id}`)
			.sort((a, b) => a.localeCompare(b))
			.join(", ");
		const authHint = inlineApiKey
			? "--api-key does not choose a provider."
			: result.usableCount === 0
				? "No matching provider is authenticated."
				: "More than one matching provider is authenticated.";
		return {
			model: undefined,
			warning: undefined,
			error: `Model "${cliModel}" is ambiguous across providers: ${matches}. ${authHint} Use --provider or provider/model.`,
		};
	}

	const { target } = result;
	if (!target) {
		return {
			model: undefined,
			warning: undefined,
			error: `Model "${cliModel}" not found. Use --list-models to see available models.`,
		};
	}

	// Use the thinking level suffix only when --thinking is not explicitly provided; otherwise it
	// stays part of the custom model id.
	// e.g. "zai-org/GLM-5.1-FP8:high" → modelId="zai-org/GLM-5.1-FP8", fallbackThinking="high"
	const modelId = cliThinking ? target.modelText : target.modelId;
	const fallbackThinking = cliThinking ? undefined : target.thinkingLevel;
	const fallbackModel = buildFallbackModel(target.providerModels, modelId);
	const requestedThinking = cliThinking ?? fallbackThinking;
	return {
		model: requestedThinking && requestedThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel,
		thinkingLevel: fallbackThinking,
		warning: `Model "${modelId}" not found for provider "${target.provider}". Using custom model id.`,
		error: undefined,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. First model from scoped models (if not continuing/resuming)
 * 2. Saved default from settings
 * 3. First available model with valid API key
 */
export async function findInitialModel(options: {
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	modelRuntime: ModelRuntime;
}): Promise<InitialModelResult> {
	const {
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelThinkingLevels,
		modelRuntime,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. Use first model from scoped models (skip if continuing/resuming)
	if (scopedModels.length > 0 && !isContinuing) {
		const scopedModel = scopedModels[0];
		const perModel = modelThinkingLevels?.[`${scopedModel.model.provider}/${scopedModel.model.id}`];
		return {
			model: scopedModel.model,
			thinkingLevel: scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 2. Try saved default from settings if auth is configured.
	if (defaultProvider && defaultModelId) {
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			model = found;
			const perModel = modelThinkingLevels?.[`${defaultProvider}/${defaultModelId}`];
			if (perModel) {
				thinkingLevel = perModel;
			} else if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 3. Try first available model with valid API key
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		// Try to find a default model from known providers
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				return { model: match, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
			}
		}

		// If no default found, use first available
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 4. No model found
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * Restore model from session, with fallback to available models
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRuntime: ModelRuntime,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRuntime.getModel(savedProvider, savedModelId);

	// Check if restored model exists and still has auth configured
	const hasConfiguredAuth = restoredModel ? modelRuntime.hasConfiguredAuth(restoredModel.provider) : false;

	if (restoredModel && hasConfiguredAuth) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// Model not found or no API key - fall back
	const reason = !restoredModel ? "model no longer exists" : "no auth configured";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// If we already have a model, use it as fallback
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// Try to find any available model
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		// Try to find a default model from known providers
		let fallbackModel: Model<Api> | undefined;
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				fallbackModel = match;
				break;
			}
		}

		// If no default found, use first available
		if (!fallbackModel) {
			fallbackModel = availableModels[0];
		}

		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// No models available
	return { model: undefined, fallbackMessage: undefined };
}
