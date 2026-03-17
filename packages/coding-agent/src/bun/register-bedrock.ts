import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
	registerApiProvider,
	type SimpleStreamOptions,
	type StreamFunction,
	type StreamOptions,
} from "@mariozechner/pi-ai";

interface LazyBedrockProviderModule {
	streamBedrock: StreamFunction<"bedrock-converse-stream", StreamOptions>;
	streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions>;
}

let bedrockProviderModulePromise: Promise<LazyBedrockProviderModule> | undefined;

function forwardStream(
	target: ReturnType<typeof createAssistantMessageEventStream>,
	source: AsyncIterable<AssistantMessageEvent>,
): void {
	(async () => {
		for await (const event of source) {
			target.push(event);
		}
		target.end();
	})();
}

function createLazyLoadErrorMessage(model: Model<"bedrock-converse-stream">, error: unknown): AssistantMessage {
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

function loadBedrockProviderModule(): Promise<LazyBedrockProviderModule> {
	if (!bedrockProviderModulePromise) {
		bedrockProviderModulePromise = import("@mariozechner/pi-ai/bedrock-provider").then(
			({ bedrockProviderModule }) => {
				return {
					streamBedrock: (model, context, options) => {
						const outer = createAssistantMessageEventStream();
						const inner = bedrockProviderModule.streamBedrock(model, context, options);
						forwardStream(outer, inner);
						return outer;
					},
					streamSimpleBedrock: (model, context, options) => {
						const outer = createAssistantMessageEventStream();
						const inner = bedrockProviderModule.streamSimpleBedrock(model, context, options);
						forwardStream(outer, inner);
						return outer;
					},
				};
			},
		);
	}
	return bedrockProviderModulePromise;
}

const streamBedrockLazy: StreamFunction<"bedrock-converse-stream", StreamOptions> = (model, context, options) => {
	const outer = createAssistantMessageEventStream();

	loadBedrockProviderModule()
		.then((module) => {
			const inner = module.streamBedrock(model, context, options);
			forwardStream(outer, inner);
		})
		.catch((error) => {
			const message = createLazyLoadErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
};

const streamSimpleBedrockLazy: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model,
	context,
	options,
) => {
	const outer = createAssistantMessageEventStream();

	loadBedrockProviderModule()
		.then((module) => {
			const inner = module.streamSimpleBedrock(model, context, options);
			forwardStream(outer, inner);
		})
		.catch((error) => {
			const message = createLazyLoadErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
};

registerApiProvider({
	api: "bedrock-converse-stream",
	stream: streamBedrockLazy,
	streamSimple: streamSimpleBedrockLazy,
});
