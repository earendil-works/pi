import {
	type ApiKeyCredential,
	type AuthContext,
	type AuthResult,
	type ClassifierModel,
	isModelType,
	lazyStream,
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
import { createManagedLlama, type ManagedLlama, type ManagedLlamaServerInfo } from "./managed.ts";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
/** Credential env key that selects managed mode, where pi starts llama-server itself. */
export const LLAMA_MODE_ENV = "LLAMA_MODE";
export const LLAMA_MANAGED_MODE = "managed";
/**
 * Placeholder server URL for managed models. The managed server listens on a random port chosen at startup,
 * so streams replace this URL with the running server's URL at request time.
 */
export const MANAGED_LLAMA_SERVER_URL = "http://managed.llama.invalid";
const MANAGED_INFERENCE_URL = llamaInferenceUrl(MANAGED_LLAMA_SERVER_URL);
const MANAGED_SOURCE = "managed llama-server";

function isManagedCredential(credential: ApiKeyCredential | undefined): boolean {
	return credential?.env?.[LLAMA_MODE_ENV] === LLAMA_MANAGED_MODE;
}

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

function modelIsSelectable(model: LlamaModelInfo, routerAutoload: boolean, managed: boolean): boolean {
	if (model.status.value === "loaded") return true;
	// llama.cpp reports idle-slept models as "sleeping"; requests wake them automatically.
	if (model.status.value === "sleeping") return true;
	// Unloaded models are routable only when llama.cpp router autoload can load them on first use.
	if (!routerAutoload || model.status.value !== "unloaded" || model.status.failed) return false;
	// A connected router may be shared and list every cached model, so only its deliberate presets are exposed.
	// pi owns the managed router, so all of its local and downloaded models are selectable.
	return managed || model.source === "preset";
}

async function routerAutoloadEnabled(
	client: LlamaClient,
	catalog: readonly LlamaModelInfo[],
	managed: boolean,
	signal: AbortSignal,
): Promise<boolean> {
	if (!catalog.some((model) => model.status.value === "unloaded" && (managed || model.source === "preset"))) {
		return false;
	}
	try {
		const autoload = (await client.props({ signal })).models_autoload;
		// Older routers do not report the flag. Autoload is llama.cpp's default, and pi starts the managed router
		// without --no-models-autoload unless llamaCpp.args adds it.
		return managed ? autoload !== false : autoload === true;
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

export interface LlamaCatalogOptions {
	routerAutoload?: boolean;
	managed?: boolean;
}

export interface LlamaProviderController {
	provider: Provider<"openai-completions">;
	/** `serverUrl` is the URL of the router that produced `models`; managed catalogs ignore it. */
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: LlamaCatalogOptions): void;
}

export function createLlamaProvider(managed: ManagedLlama = createManagedLlama()): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];
	let classifiers: readonly ClassifierModel<"llama-cpp-classify">[] = [];
	const classifier = llamaCppClassifyApi();

	const setCatalog = (
		catalog: readonly LlamaModelInfo[],
		serverUrl: string,
		options: LlamaCatalogOptions = {},
	): void => {
		const isManaged = options.managed === true;
		const modelServerUrl = isManaged ? MANAGED_LLAMA_SERVER_URL : serverUrl;
		const selectable = catalog.filter((model) =>
			modelIsSelectable(model, options.routerAutoload === true, isManaged),
		);
		models = selectable.map((model) => toPiModel(model, modelServerUrl));
		classifiers = selectable.map((model) => toPiClassifierModel(model, modelServerUrl));
	};

	// Managed models carry the placeholder URL; start or join the server and send the request to its real URL.
	const withManagedServer = <T extends { apiKey?: string; signal?: AbortSignal }>(
		model: Model<"openai-completions">,
		options: T | undefined,
		run: (model: Model<"openai-completions">, options: T | undefined) => ReturnType<typeof stream>,
	): ReturnType<typeof stream> => {
		if (model.baseUrl !== MANAGED_INFERENCE_URL) return run(model, options);
		return lazyStream(model, async () => {
			const server = await managed.acquire(options?.signal);
			return run({ ...model, baseUrl: llamaInferenceUrl(server.url) }, { ...options, apiKey: server.apiKey } as T);
		});
	};

	const provider: Provider<"openai-completions"> = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const mode = await interaction.prompt({
						type: "select",
						message: "How should pi reach llama.cpp?",
						options: [
							{
								id: LLAMA_MANAGED_MODE,
								label: "Start llama-server automatically",
								description: "pi runs llama-server on a random local port and stops it when unused",
							},
							{
								id: "connect",
								label: "Connect to a running server",
								description: "Use an existing llama-server router URL",
							},
						],
					});
					if (mode === LLAMA_MANAGED_MODE) {
						const version = await managed.verify(interaction.signal);
						interaction.notify({
							type: "info",
							message: `Found llama-server ${version}. It starts when a llama.cpp model is first used. Run /llama to download or load models.`,
						});
						return { type: "api_key", env: { [LLAMA_MODE_ENV]: LLAMA_MANAGED_MODE } };
					}

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
					if (isManagedCredential(credential)) return { type: "api_key", source: MANAGED_SOURCE };
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					if (isManagedCredential(credential)) {
						// Resolution runs for catalog refreshes too, so it must not start the server.
						return {
							auth: { apiKey: LLAMA_MANAGED_MODE, baseUrl: MANAGED_INFERENCE_URL },
							env: { [LLAMA_MODE_ENV]: LLAMA_MANAGED_MODE },
							source: MANAGED_SOURCE,
						};
					}
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
			const isManaged = isManagedCredential(context.credential);
			let client: LlamaClient;
			let modelServerUrl: string;
			if (isManaged) {
				// Refresh only from an already running server; starting one here would launch it on every pi start.
				const server = await managed.probe();
				if (!server) return;
				client = new LlamaClient(server.url, server.apiKey);
				modelServerUrl = MANAGED_LLAMA_SERVER_URL;
			} else {
				const serverUrl = credentialServerUrl(context.credential);
				if (!serverUrl) return;
				client = new LlamaClient(serverUrl, context.credential.key);
				modelServerUrl = serverUrl;
			}
			if (context.signal.aborted) return;
			const catalog = await client.list({ signal: context.signal });
			if (context.signal.aborted) return;
			const routerAutoload = await routerAutoloadEnabled(client, catalog, isManaged, context.signal);
			if (context.signal.aborted) return;
			const selectable = catalog.filter((model) => modelIsSelectable(model, routerAutoload, isManaged));
			const refreshed = await Promise.all(
				selectable.map(async (model) => {
					const cachedContextWindow = cachedContextWindows.get(model.id);
					// Only loaded models expose their template without side effects. Unloaded autoload models
					// would need to be loaded, while querying sleeping models may wake them. Those models remain
					// unclassified until they are loaded or woken and a later catalog refresh discovers them.
					if (model.status.value !== "loaded")
						return toPiModel(model, modelServerUrl, undefined, cachedContextWindow);
					const props = await client.props({ model: model.id, signal: context.signal });
					return toPiModel(model, modelServerUrl, props, cachedContextWindow);
				}),
			);
			const refreshedClassifiers = selectable.map((model) =>
				toPiClassifierModel(model, modelServerUrl, cachedContextWindows.get(model.id)),
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
		stream: (model, context, options) =>
			withManagedServer(model, options as ProviderStreamOptions | undefined, (requestModel, requestOptions) =>
				stream(requestModel, context, requestOptions),
			),
		streamSimple: (model, context, options) =>
			withManagedServer(model, options, (requestModel, requestOptions) =>
				streamSimple(requestModel, context, requestOptions),
			),
		classify: async (model, context, options) => {
			// Auth resolution replaces the catalog URL with the inference URL (`/v1`), so accept both placeholder forms.
			if (model.baseUrl !== MANAGED_LLAMA_SERVER_URL && model.baseUrl !== MANAGED_INFERENCE_URL) {
				return classifier.classify(model, context, options);
			}
			let server: ManagedLlamaServerInfo;
			try {
				server = await managed.acquire(options?.signal);
			} catch (error) {
				// Classifiers report failures in the result, like the stream path does through lazyStream.
				return {
					api: model.api,
					provider: model.provider,
					model: model.id,
					answers: {},
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				};
			}
			return classifier.classify({ ...model, baseUrl: server.url }, context, { ...options, apiKey: server.apiKey });
		},
	};

	return { provider, setCatalog };
}
