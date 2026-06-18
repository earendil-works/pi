import { type ApiProvider, clearApiProviders, getApiProvider, registerApiProvider } from "../api-registry.ts";
import { getImagesApiProvider, type ImagesApiProvider, registerImagesApiProvider } from "../images-api-registry.ts";
import type {
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEvent,
	ImagesApi,
	ImagesContext,
	ImagesModel,
	ImagesOptions,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import type { BedrockOptions } from "./amazon-bedrock.ts";
import type { AnthropicOptions } from "./anthropic.ts";
import type { AzureOpenAIResponsesOptions } from "./azure-openai-responses.ts";
import type { GoogleOptions } from "./google.ts";
import type { GoogleVertexOptions } from "./google-vertex.ts";
import type { MistralOptions } from "./mistral.ts";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./openai-completions.ts";
import type { OpenAIResponsesOptions } from "./openai-responses.ts";

interface RegisteringProviderModule {
	register(): void;
}

function createLazyLoadErrorImages(model: ImagesModel<"openrouter-images">, error: unknown): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function createLazyImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
): ImagesApiProvider<TApi, TOptions> {
	return {
		api,
		generateImages: async (model: ImagesModel<TApi>, context: ImagesContext, options?: TOptions) => {
			try {
				const module = await loadModule();
				module.register();
				const provider = getImagesApiProvider(api);
				if (!provider) {
					throw new Error(`No API provider registered for api: ${api}`);
				}
				return await provider.generateImages(model, context, options);
			} catch (error) {
				return createLazyLoadErrorImages(model as ImagesModel<"openrouter-images">, error);
			}
		},
	};
}

interface BedrockProviderModule {
	streamBedrock: StreamFunction<"bedrock-converse-stream", BedrockOptions>;
	streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions>;
}

const importNodeOnlyProvider = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let bedrockProviderModuleOverride: BedrockProviderModule | undefined;

export function setBedrockProviderModule(module: BedrockProviderModule): void {
	bedrockProviderModuleOverride = module;
}

function forwardStream(target: AssistantMessageEventStream, source: AsyncIterable<AssistantMessageEvent>): void {
	(async () => {
		for await (const event of source) {
			target.push(event);
		}
		target.end();
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

async function loadAndRegisterProvider<TApi extends Api>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
) {
	const module = await loadModule();
	module.register();
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

function createLazyStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
): StreamFunction<TApi, TOptions> {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();

		loadAndRegisterProvider(api, loadModule)
			.then((provider) => {
				const inner = provider.stream(model, context, options);
				forwardStream(outer, inner);
			})
			.catch((error) => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

function createLazySimpleStream<TApi extends Api>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
): StreamFunction<TApi, SimpleStreamOptions> {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();

		loadAndRegisterProvider(api, loadModule)
			.then((provider) => {
				const inner = provider.streamSimple(model, context, options);
				forwardStream(outer, inner);
			})
			.catch((error) => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

function createLazyApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
): ApiProvider<TApi, TOptions> {
	return {
		api,
		stream: createLazyStream<TApi, TOptions>(api, loadModule),
		streamSimple: createLazySimpleStream(api, loadModule),
	};
}

function registerBedrockProviderModule(module: BedrockProviderModule): void {
	registerApiProvider({
		api: "bedrock-converse-stream",
		stream: module.streamBedrock,
		streamSimple: module.streamSimpleBedrock,
	});
}

function loadBedrockProviderModule(): Promise<RegisteringProviderModule> {
	const module = bedrockProviderModuleOverride;
	if (module) {
		return Promise.resolve({ register: () => registerBedrockProviderModule(module) });
	}
	return importNodeOnlyProvider("./amazon-bedrock.ts").then((provider) => provider as RegisteringProviderModule);
}

const anthropicProvider = createLazyApiProvider<"anthropic-messages", AnthropicOptions>(
	"anthropic-messages",
	() => import("./anthropic.ts"),
);
const azureOpenAIResponsesProvider = createLazyApiProvider<"azure-openai-responses", AzureOpenAIResponsesOptions>(
	"azure-openai-responses",
	() => import("./azure-openai-responses.ts"),
);
const googleProvider = createLazyApiProvider<"google-generative-ai", GoogleOptions>(
	"google-generative-ai",
	() => import("./google.ts"),
);
const googleVertexProvider = createLazyApiProvider<"google-vertex", GoogleVertexOptions>(
	"google-vertex",
	() => import("./google-vertex.ts"),
);
const mistralProvider = createLazyApiProvider<"mistral-conversations", MistralOptions>(
	"mistral-conversations",
	() => import("./mistral.ts"),
);
const openAICodexResponsesProvider = createLazyApiProvider<"openai-codex-responses", OpenAICodexResponsesOptions>(
	"openai-codex-responses",
	() => import("./openai-codex-responses.ts"),
);
const openAICompletionsProvider = createLazyApiProvider<"openai-completions", OpenAICompletionsOptions>(
	"openai-completions",
	() => import("./openai-completions.ts"),
);
const openAIResponsesProvider = createLazyApiProvider<"openai-responses", OpenAIResponsesOptions>(
	"openai-responses",
	() => import("./openai-responses.ts"),
);
const bedrockProvider = createLazyApiProvider<"bedrock-converse-stream", BedrockOptions>(
	"bedrock-converse-stream",
	loadBedrockProviderModule,
);
const openRouterImagesProvider = createLazyImagesApiProvider(
	"openrouter-images",
	() => import("./images/openrouter.ts"),
);

export const generateImagesOpenRouter = openRouterImagesProvider.generateImages;
export const streamAnthropic = anthropicProvider.stream;
export const streamSimpleAnthropic = anthropicProvider.streamSimple;
export const streamAzureOpenAIResponses = azureOpenAIResponsesProvider.stream;
export const streamSimpleAzureOpenAIResponses = azureOpenAIResponsesProvider.streamSimple;
export const streamGoogle = googleProvider.stream;
export const streamSimpleGoogle = googleProvider.streamSimple;
export const streamGoogleVertex = googleVertexProvider.stream;
export const streamSimpleGoogleVertex = googleVertexProvider.streamSimple;
export const streamMistral = mistralProvider.stream;
export const streamSimpleMistral = mistralProvider.streamSimple;
export const streamOpenAICodexResponses = openAICodexResponsesProvider.stream;
export const streamSimpleOpenAICodexResponses = openAICodexResponsesProvider.streamSimple;
export const streamOpenAICompletions = openAICompletionsProvider.stream;
export const streamSimpleOpenAICompletions = openAICompletionsProvider.streamSimple;
export const streamOpenAIResponses = openAIResponsesProvider.stream;
export const streamSimpleOpenAIResponses = openAIResponsesProvider.streamSimple;

const registerBuiltInApiProviderFunctions = [
	() => registerApiProvider(anthropicProvider),
	() => registerApiProvider(openAICompletionsProvider),
	() => registerApiProvider(mistralProvider),
	() => registerApiProvider(openAIResponsesProvider),
	() => registerApiProvider(azureOpenAIResponsesProvider),
	() => registerApiProvider(openAICodexResponsesProvider),
	() => registerApiProvider(googleProvider),
	() => registerApiProvider(googleVertexProvider),
	() => registerApiProvider(bedrockProvider),
];

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider(openRouterImagesProvider);
}

export function registerBuiltInApiProviders(): void {
	for (const register of registerBuiltInApiProviderFunctions) {
		register();
	}
}

export function resetApiProviders(): void {
	clearApiProviders();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();
