import {
	type AnyModel,
	type ApiKeyCredential,
	type AuthContext,
	type AuthResult,
	type ClassifierModel,
	isModelType,
	type Model,
	type Provider,
	type ProviderStreamOptions,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { llamaCppClassifyApi } from "@earendil-works/pi-ai/api/llama-cpp-classify.lazy";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import {
	LlamaClient,
	type LlamaModelInfo,
	type LlamaServerProps,
	llamaInferenceUrl,
	normalizeLlamaServerUrl,
} from "./client.ts";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

function modelIsSelectable(model: LlamaModelInfo, routerAutoload: boolean): boolean {
	if (model.status.value === "loaded") return true;
	// llama.cpp reports idle-slept models as "sleeping"; requests wake them automatically.
	if (model.status.value === "sleeping") return true;
	// Unloaded presets are routable only when llama.cpp router autoload can load them on first use.
	return routerAutoload && model.status.value === "unloaded" && !model.status.failed && model.source === "preset";
}

async function routerAutoloadEnabled(
	client: LlamaClient,
	catalog: readonly LlamaModelInfo[],
	signal: AbortSignal,
): Promise<boolean> {
	if (!catalog.some((model) => model.status.value === "unloaded" && model.source === "preset")) return false;
	try {
		return (await client.props({ signal })).models_autoload === true;
	} catch {
		return false;
	}
}

function configuredContextWindow(model: LlamaModelInfo): number | undefined {
	const args = model.status.args ?? [];
	for (let index = 0; index < args.length - 1; index++) {
		const flag = args[index];
		if (flag !== "--ctx-size" && flag !== "-c" && flag !== "-ctx") continue;
		const contextWindow = Number(args[index + 1]);
		if (Number.isSafeInteger(contextWindow) && contextWindow > 0) return contextWindow;
	}
	return undefined;
}

function contextWindowOf(model: LlamaModelInfo, cachedContextWindow?: number): number {
	const runtimeContextWindow = model.meta?.n_ctx;
	if (runtimeContextWindow && runtimeContextWindow > 0) return runtimeContextWindow;
	const configuredContext = configuredContextWindow(model);
	if (configuredContext) return configuredContext;
	if (cachedContextWindow && cachedContextWindow > 0) return cachedContextWindow;
	const trainingContextWindow = model.meta?.n_ctx_train;
	return trainingContextWindow && trainingContextWindow > 0 ? trainingContextWindow : 128000;
}

type LlamaClassifierApi = "llama-cpp-classify" | "typesafe-system-one";

/**
 * A llama.cpp model used as a classifier. Decision models answer natively through llama.cpp's
 * System One endpoint (`/v1/systemone`). Chat models fall back to `llama-cpp-classify`, which reads
 * answers from next-token label probabilities.
 */
function toPiClassifierModel(
	model: LlamaModelInfo,
	serverUrl: string,
	decision: boolean,
	cachedContextWindow?: number,
): ClassifierModel<LlamaClassifierApi> {
	return {
		type: "classifier",
		id: model.id,
		name: model.id,
		api: decision ? "typesafe-system-one" : "llama-cpp-classify",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: decision ? llamaInferenceUrl(serverUrl) : serverUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindowOf(model, cachedContextWindow),
	};
}

function isLlamaClassifierModel(model: AnyModel): model is ClassifierModel<LlamaClassifierApi> {
	return (
		isModelType(model, "classifier") && (model.api === "llama-cpp-classify" || model.api === "typesafe-system-one")
	);
}

function toPiModel(
	model: LlamaModelInfo,
	serverUrl: string,
	props?: LlamaServerProps,
	cachedContextWindow?: number,
): Model<"openai-completions"> {
	const contextWindow = contextWindowOf(model, cachedContextWindow);
	const reasoning = props?.chat_template?.includes("enable_thinking") === true;
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning,
		...(reasoning && {
			thinkingLevelMap: { off: "off", minimal: null, low: null, medium: "medium", high: null, xhigh: null },
		}),
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			...(reasoning && { thinkingFormat: "qwen-chat-template" }),
		},
	};
}

export interface LlamaProviderController {
	provider: Provider<"openai-completions">;
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: { routerAutoload?: boolean }): void;
}

export function createLlamaProvider(): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];
	let classifiers: readonly ClassifierModel<LlamaClassifierApi>[] = [];
	// Model kinds, keyed by server URL and model ID. A probe is a POST, which llama.cpp's router counts as use of
	// the model for its LRU eviction, so a loaded model is probed once per session and the result is trusted
	// for the rest of the session. Only answered probes are recorded. A model listed without a probe defaults to
	// chat, and that default must not stop the probe once the model is loaded.
	const probedKinds = new Map<string, "chat" | "decision">();
	// Decision models from the model store, found by a probe in an earlier session. They stay decision models
	// while unloaded or sleeping, but are probed again once loaded: a preset name or alias can point to a
	// different GGUF after a configuration change.
	let storedDecisionModels = new Set<string>();
	const kindKey = (serverUrl: string, id: string): string => `${serverUrl}\u0000${id}`;
	const knownKind = (key: string): "chat" | "decision" | undefined =>
		probedKinds.get(key) ?? (storedDecisionModels.has(key) ? "decision" : undefined);
	const isDecisionModel = (serverUrl: string, id: string): boolean => knownKind(kindKey(serverUrl, id)) === "decision";
	const fallbackClassifier = llamaCppClassifyApi();
	const decisionClassifier = typesafeSystemOneApi();

	const setCatalog = (
		catalog: readonly LlamaModelInfo[],
		serverUrl: string,
		options: { routerAutoload?: boolean } = {},
	): void => {
		const selectable = catalog.filter((model) => modelIsSelectable(model, options.routerAutoload === true));
		models = selectable
			.filter((model) => !isDecisionModel(serverUrl, model.id))
			.map((model) => toPiModel(model, serverUrl));
		classifiers = selectable.map((model) =>
			toPiClassifierModel(model, serverUrl, isDecisionModel(serverUrl, model.id)),
		);
	};

	const provider: Provider<"openai-completions"> = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "llama.cpp server URL",
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					const serverUrl = normalizeLlamaServerUrl(
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "API key (optional)",
						})
					).trim();
					await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
					return {
						type: "api_key",
						key: apiKey || undefined,
						env: { LLAMA_BASE_URL: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
					return {
						auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
						env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
						source: credential ? "stored credential" : "LLAMA_BASE_URL",
					};
				},
			},
		},
		getModels: () => models,
		getAllModels: () => [...models, ...classifiers],
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			const cachedContextWindows = new Map<string, number>();
			if (context.stored) {
				const stored = context.stored.models.filter((model) => model.provider === LLAMA_PROVIDER_ID);
				const restored = stored.filter(
					(model): model is Model<"openai-completions"> =>
						isModelType(model, "chat") && model.api === "openai-completions",
				);
				const restoredClassifiers = stored.filter(isLlamaClassifierModel);
				for (const model of [...restored, ...restoredClassifiers]) {
					cachedContextWindows.set(model.id, model.contextWindow);
				}
				storedDecisionModels = new Set(
					restoredClassifiers
						.filter((model) => model.api === "typesafe-system-one")
						.map((model) => kindKey(normalizeLlamaServerUrl(model.baseUrl), model.id)),
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
							classifiers = restoredClassifiers;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
			const serverUrl = credentialServerUrl(context.credential);
			if (!serverUrl) return;
			const client = new LlamaClient(serverUrl, context.credential.key);
			const catalog = await client.list({ signal: context.signal });
			if (context.signal.aborted) return;
			const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal);
			if (context.signal.aborted) return;
			const selectable = catalog.filter((model) => modelIsSelectable(model, routerAutoload));
			// Only loaded models are probed and queried for their chat template. Unloaded autoload presets would
			// need to be loaded, while querying sleeping models may wake them. Those models keep their known kind,
			// or default to chat, until they are loaded and a later catalog refresh probes them.
			const entries = await Promise.all(
				selectable.map(async (model) => {
					const cachedContextWindow = cachedContextWindows.get(model.id);
					const key = kindKey(serverUrl, model.id);
					if (model.status.value !== "loaded") {
						const decision = knownKind(key) === "decision";
						return {
							chat: decision ? undefined : toPiModel(model, serverUrl, undefined, cachedContextWindow),
							classifier: toPiClassifierModel(model, serverUrl, decision, cachedContextWindow),
						};
					}
					let kind = probedKinds.get(key);
					if (!kind) {
						try {
							kind = (await client.isDecisionModel(model.id, context.signal)) ? "decision" : "chat";
							probedKinds.set(key, kind);
						} catch (error) {
							// A failed probe records nothing, so the next refresh probes again. Until then the model
							// keeps its stored kind, or defaults to chat.
							if (context.signal.aborted) throw error;
							kind = knownKind(key);
						}
					}
					if (kind === "decision") {
						return {
							chat: undefined,
							classifier: toPiClassifierModel(model, serverUrl, true, cachedContextWindow),
						};
					}
					const props = await client.props({ model: model.id, signal: context.signal });
					return {
						chat: toPiModel(model, serverUrl, props, cachedContextWindow),
						classifier: toPiClassifierModel(model, serverUrl, false, cachedContextWindow),
					};
				}),
			);
			const refreshed = entries
				.map((entry) => entry.chat)
				.filter((model): model is Model<"openai-completions"> => model !== undefined);
			const refreshedClassifiers = entries.map((entry) => entry.classifier);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: [...refreshed, ...refreshedClassifiers], checkedAt: Date.now() },
				update: () => {
					models = refreshed;
					classifiers = refreshedClassifiers;
				},
			});
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
		classify: (model, context, options) =>
			(model.api === "typesafe-system-one" ? decisionClassifier : fallbackClassifier).classify(
				model,
				context,
				options,
			),
	};

	return { provider, setCatalog };
}
