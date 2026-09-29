import {
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

/** The same llama.cpp model used as a classifier: answers are read from next-token label probabilities. */
function toPiClassifierModel(
	model: LlamaModelInfo,
	serverUrl: string,
	cachedContextWindow?: number,
): ClassifierModel<"llama-cpp-classify"> {
	return {
		type: "classifier",
		id: model.id,
		name: model.id,
		api: "llama-cpp-classify",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: serverUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindowOf(model, cachedContextWindow),
	};
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
	let classifiers: readonly ClassifierModel<"llama-cpp-classify">[] = [];
	const classifier = llamaCppClassifyApi();

	const setCatalog = (
		catalog: readonly LlamaModelInfo[],
		serverUrl: string,
		options: { routerAutoload?: boolean } = {},
	): void => {
		const selectable = catalog.filter((model) => modelIsSelectable(model, options.routerAutoload === true));
		models = selectable.map((model) => toPiModel(model, serverUrl));
		classifiers = selectable.map((model) => toPiClassifierModel(model, serverUrl));
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
				const restoredClassifiers = stored.filter(
					(model): model is ClassifierModel<"llama-cpp-classify"> =>
						isModelType(model, "classifier") && model.api === "llama-cpp-classify",
				);
				for (const model of [...restored, ...restoredClassifiers]) {
					cachedContextWindows.set(model.id, model.contextWindow);
				}
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
			const refreshed = await Promise.all(
				selectable.map(async (model) => {
					const cachedContextWindow = cachedContextWindows.get(model.id);
					// Only loaded models expose their template without side effects. Unloaded autoload presets
					// would need to be loaded, while querying sleeping models may wake them. Those models remain
					// unclassified until they are loaded or woken and a later catalog refresh discovers them.
					if (model.status.value !== "loaded") return toPiModel(model, serverUrl, undefined, cachedContextWindow);
					const props = await client.props({ model: model.id, signal: context.signal });
					return toPiModel(model, serverUrl, props, cachedContextWindow);
				}),
			);
			const refreshedClassifiers = selectable.map((model) =>
				toPiClassifierModel(model, serverUrl, cachedContextWindows.get(model.id)),
			);
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
		classify: (model, context, options) => classifier.classify(model, context, options),
	};

	return { provider, setCatalog };
}
