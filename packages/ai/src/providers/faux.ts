import { createProvider, type Provider } from "../models.ts";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";

const DEFAULT_API = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";
const DEFAULT_MODEL_NAME = "Faux Model";
const DEFAULT_BASE_URL = "http://localhost:0";
const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

const DEFAULT_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface FauxModelDefinition {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	return {
		type: "toolCall",
		id: options.id ?? randomId("tool"),
		name,
		arguments: arguments_,
	};
}

function normalizeFauxAssistantContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	if (typeof content === "string") {
		return [fauxText(content)];
	}
	return Array.isArray(content) ? content : [content];
}

export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: {
		stopReason?: AssistantMessage["stopReason"];
		deferred?: DeferredHandle;
		errorMessage?: string;
		responseId?: string;
		timestamp?: number;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeFauxAssistantContent(content),
		api: DEFAULT_API,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL_ID,
		usage: DEFAULT_USAGE,
		stopReason: options.stopReason ?? "stop",
		deferred: options.deferred,
		errorMessage: options.errorMessage,
		responseId: options.responseId,
		timestamp: options.timestamp ?? Date.now(),
	};
}

export interface FauxProviderState {
	callCount: number;
	deferredFetchCount: number;
	cancelledDeferred: DeferredHandle[];
}

export type FauxResponseFactory = (
	context: Context,
	options: SimpleStreamOptions | undefined,
	state: FauxProviderState,
	model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;

export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

export interface RegisterFauxProviderOptions {
	api?: string;
	provider?: string;
	models?: FauxModelDefinition[];
	deferred?: {
		/** Number of fetches that return the original handle before the scripted response becomes ready. */
		pendingFetches?: number;
		pollAfterMs?: number;
	};
	tokensPerSecond?: number;
	tokenSize?: {
		min?: number;
		max?: number;
	};
}

export interface FauxProviderRegistration {
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	unregister: () => void;
}

export interface FauxProviderHandle {
	provider: Provider;
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function randomId(prefix: string): string {
	return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function contentToText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			return `[image:${block.mimeType}:${block.data.length}]`;
		})
		.join("\n");
}

function assistantContentToText(content: Array<TextContent | ThinkingContent | ToolCall>): string {
	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			if (block.type === "thinking") {
				return block.thinking;
			}
			return `${block.name}:${JSON.stringify(block.arguments)}`;
		})
		.join("\n");
}

function toolResultToText(message: ToolResultMessage): string {
	return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n");
}

function messageToText(message: Message): string {
	if (message.role === "user") {
		return contentToText(message.content);
	}
	if (message.role === "assistant") {
		return assistantContentToText(message.content);
	}
	return toolResultToText(message);
}

function serializeContext(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt) {
		parts.push(`system:${context.systemPrompt}`);
	}
	for (const message of context.messages) {
		parts.push(`${message.role}:${messageToText(message)}`);
	}
	if (context.tools?.length) {
		parts.push(`tools:${JSON.stringify(context.tools)}`);
	}
	return parts.join("\n\n");
}

function commonPrefixLength(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) {
		index++;
	}
	return index;
}

function withUsageEstimate(
	message: AssistantMessage,
	context: Context,
	options: StreamOptions | undefined,
	promptCache: Map<string, string>,
): AssistantMessage {
	const promptText = serializeContext(context);
	const promptTokens = estimateTokens(promptText);
	const outputTokens = estimateTokens(assistantContentToText(message.content));
	let input = promptTokens;
	let cacheRead = 0;
	let cacheWrite = 0;
	const sessionId = options?.sessionId;

	if (sessionId && options?.cacheRetention !== "none") {
		const previousPrompt = promptCache.get(sessionId);
		if (previousPrompt) {
			const cachedChars = commonPrefixLength(previousPrompt, promptText);
			cacheRead = estimateTokens(previousPrompt.slice(0, cachedChars));
			cacheWrite = estimateTokens(promptText.slice(cachedChars));
			input = Math.max(0, promptTokens - cacheRead);
		} else {
			cacheWrite = promptTokens;
		}
		promptCache.set(sessionId, promptText);
	}

	return {
		...message,
		usage: {
			input,
			output: outputTokens,
			cacheRead,
			cacheWrite,
			totalTokens: input + outputTokens + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function splitStringByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
	const chunks: string[] = [];
	let index = 0;
	while (index < text.length) {
		const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
		const charSize = Math.max(1, tokenSize * 4);
		chunks.push(text.slice(index, index + charSize));
		index += charSize;
	}
	return chunks.length > 0 ? chunks : [""];
}

function cloneMessage(message: AssistantMessage, api: string, provider: string, modelId: string): AssistantMessage {
	const cloned = structuredClone(message);
	return {
		...cloned,
		api,
		provider,
		model: modelId,
		timestamp: cloned.timestamp ?? Date.now(),
		usage: cloned.usage ?? DEFAULT_USAGE,
	};
}

function createDeferredMessage(model: Model<string>, handle: DeferredHandle): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: DEFAULT_USAGE,
		stopReason: "deferred",
		deferred: handle,
		timestamp: Date.now(),
	};
}

function createErrorMessage(error: unknown, api: string, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: DEFAULT_USAGE,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function createAbortedMessage(partial: AssistantMessage): AssistantMessage {
	return {
		...partial,
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: Date.now(),
	};
}

function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
	if (!tokensPerSecond || tokensPerSecond <= 0) {
		return new Promise((resolve) => queueMicrotask(resolve));
	}
	const delayMs = (estimateTokens(chunk) / tokensPerSecond) * 1000;
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function streamWithDeltas(
	stream: AssistantMessageEventStream,
	message: AssistantMessage,
	minTokenSize: number,
	maxTokenSize: number,
	tokensPerSecond: number | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	if (signal?.aborted) {
		const aborted = createAbortedMessage(partial);
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
		return;
	}

	stream.push({ type: "start", partial: { ...partial } });

	for (let index = 0; index < message.content.length; index++) {
		if (signal?.aborted) {
			const aborted = createAbortedMessage(partial);
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}

		const block = message.content[index];

		if (block.type === "thinking") {
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			stream.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
			for (const chunk of splitStringByTokenSize(block.thinking, minTokenSize, maxTokenSize)) {
				await scheduleChunk(chunk, tokensPerSecond);
				if (signal?.aborted) {
					const aborted = createAbortedMessage(partial);
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
					return;
				}
				(partial.content[index] as ThinkingContent).thinking += chunk;
				stream.push({ type: "thinking_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
			}
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: { ...partial },
			});
			continue;
		}

		if (block.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
			for (const chunk of splitStringByTokenSize(block.text, minTokenSize, maxTokenSize)) {
				await scheduleChunk(chunk, tokensPerSecond);
				if (signal?.aborted) {
					const aborted = createAbortedMessage(partial);
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
					return;
				}
				(partial.content[index] as TextContent).text += chunk;
				stream.push({ type: "text_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
			}
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } });
			continue;
		}

		partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
		stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
		for (const chunk of splitStringByTokenSize(JSON.stringify(block.arguments), minTokenSize, maxTokenSize)) {
			await scheduleChunk(chunk, tokensPerSecond);
			if (signal?.aborted) {
				const aborted = createAbortedMessage(partial);
				stream.push({ type: "error", reason: "aborted", error: aborted });
				stream.end(aborted);
				return;
			}
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
		}
		(partial.content[index] as ToolCall).arguments = block.arguments;
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...partial } });
	}

	if (message.stopReason === "pending") {
		throw new Error("Faux response ended without a stop reason");
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
		stream.end(message);
		return;
	}

	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
}

export function createFauxCore(options: RegisterFauxProviderOptions) {
	const api = options.api ?? randomId(DEFAULT_API);
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const minTokenSize = Math.max(
		1,
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
	);
	const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	let pendingResponses: FauxResponseStep[] = [];
	const tokensPerSecond = options.tokensPerSecond;
	const state: FauxProviderState = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] };
	const promptCache = new Map<string, string>();
	const deferredResponses = new Map<
		string,
		{
			handle: DeferredHandle;
			step: FauxResponseStep;
			context: Context;
			options: SimpleStreamOptions | undefined;
			model: Model<string>;
			pendingFetches: number;
			cancelled: boolean;
			final?: AssistantMessage;
		}
	>();

	const modelDefinitions = options.models?.length
		? options.models
		: [
				{
					id: DEFAULT_MODEL_ID,
					name: DEFAULT_MODEL_NAME,
					reasoning: false,
					input: ["text", "image"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			];
	const models = modelDefinitions.map((definition) => ({
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider,
		baseUrl: DEFAULT_BASE_URL,
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text", "image"],
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
	})) as [Model<string>, ...Model<string>[]];

	const resolveResponse = async (
		step: FauxResponseStep,
		context: Context,
		streamOptions: SimpleStreamOptions | undefined,
		requestModel: Model<string>,
	): Promise<AssistantMessage> => {
		const resolved = typeof step === "function" ? await step(context, streamOptions, state, requestModel) : step;
		return withUsageEstimate(
			cloneMessage(resolved, api, provider, requestModel.id),
			context,
			streamOptions,
			promptCache,
		);
	};

	const stream: StreamFunction<string, SimpleStreamOptions> = (requestModel, context, streamOptions) => {
		const outer = createAssistantMessageEventStream();
		const step = pendingResponses.shift();
		state.callCount++;

		queueMicrotask(async () => {
			try {
				await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				if (!step) {
					let message = createErrorMessage(
						new Error("No more faux responses queued"),
						api,
						provider,
						requestModel.id,
					);
					message = withUsageEstimate(message, context, streamOptions, promptCache);
					outer.push({ type: "error", reason: "error", error: message });
					outer.end(message);
					return;
				}

				if (streamOptions?.deferred) {
					const handle: DeferredHandle = {
						provider: requestModel.provider,
						modelId: requestModel.id,
						api: requestModel.api,
						id: randomId("deferred"),
						...(options.deferred?.pollAfterMs !== undefined ? { pollAfterMs: options.deferred.pollAfterMs } : {}),
					};
					deferredResponses.set(handle.id, {
						handle,
						step,
						context,
						options: streamOptions,
						model: requestModel,
						pendingFetches: Math.max(0, Math.floor(options.deferred?.pendingFetches ?? 0)),
						cancelled: false,
					});
					await streamWithDeltas(
						outer,
						createDeferredMessage(requestModel, handle),
						minTokenSize,
						maxTokenSize,
						tokensPerSecond,
						streamOptions.signal,
					);
					return;
				}

				const message = await resolveResponse(step, context, streamOptions, requestModel);
				await streamWithDeltas(outer, message, minTokenSize, maxTokenSize, tokensPerSecond, streamOptions?.signal);
			} catch (error) {
				const message = createErrorMessage(error, api, provider, requestModel.id);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});

		return outer;
	};

	const streamSimple: StreamFunction<string, SimpleStreamOptions> = (streamModel, context, streamOptions) =>
		stream(streamModel, context, streamOptions);

	const fetchDeferred = (
		requestModel: Model<string>,
		handle: DeferredHandle,
		fetchOptions?: DeferredFetchOptions,
	): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		state.deferredFetchCount++;

		queueMicrotask(async () => {
			try {
				await fetchOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				const entry = deferredResponses.get(handle.id);
				if (
					!entry ||
					entry.handle.provider !== handle.provider ||
					entry.handle.modelId !== handle.modelId ||
					entry.handle.api !== handle.api
				) {
					throw new Error(`Unknown faux deferred response: ${handle.id}`);
				}
				if (entry.cancelled) throw new Error(`Faux deferred response was cancelled: ${handle.id}`);

				if (entry.pendingFetches > 0) {
					entry.pendingFetches--;
					await streamWithDeltas(
						outer,
						createDeferredMessage(requestModel, entry.handle),
						minTokenSize,
						maxTokenSize,
						tokensPerSecond,
						fetchOptions?.signal,
					);
					return;
				}

				if (!entry.final) {
					const {
						deferred: _deferred,
						signal: _submissionSignal,
						onResponse: _submissionOnResponse,
						...submissionOptions
					} = entry.options ?? {};
					try {
						entry.final = await resolveResponse(entry.step, entry.context, submissionOptions, entry.model);
					} catch (error) {
						entry.final = createErrorMessage(error, api, provider, entry.model.id);
					}
				}
				await streamWithDeltas(
					outer,
					entry.final,
					minTokenSize,
					maxTokenSize,
					tokensPerSecond,
					fetchOptions?.signal,
				);
			} catch (error) {
				const message = createErrorMessage(error, api, provider, requestModel.id);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});

		return outer;
	};

	const cancelDeferred = async (
		requestModel: Model<string>,
		handle: DeferredHandle,
		cancelOptions?: DeferredCancelOptions,
	): Promise<void> => {
		state.cancelledDeferred.push(structuredClone(handle));
		const entry = deferredResponses.get(handle.id);
		if (entry) entry.cancelled = true;
		await cancelOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
	};

	function getModel(): Model<string>;
	function getModel(requestedModelId: string): Model<string> | undefined;
	function getModel(requestedModelId?: string): Model<string> | undefined {
		if (!requestedModelId) {
			return models[0];
		}
		return models.find((candidate) => candidate.id === requestedModelId);
	}

	return {
		api,
		provider,
		models,
		stream,
		streamSimple,
		fetchDeferred,
		cancelDeferred,
		getModel,
		state,
		setResponses(responses: FauxResponseStep[]) {
			pendingResponses = [...responses];
		},
		appendResponses(responses: FauxResponseStep[]) {
			pendingResponses.push(...responses);
		},
		getPendingResponseCount() {
			return pendingResponses.length;
		},
	};
}

/**
 * Faux provider for tests built on explicit `Models` collections:
 *
 * ```ts
 * const faux = fauxProvider();
 * const models = createModels();
 * models.setProvider(faux.provider);
 * faux.setResponses([fauxAssistantMessage("hi")]);
 * ```
 */
export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderHandle {
	const core = createFauxCore(options);
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: {
			stream: core.stream,
			streamSimple: core.streamSimple,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
	});
	return {
		provider,
		api: core.api,
		models: core.models,
		getModel: core.getModel,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		getPendingResponseCount: core.getPendingResponseCount,
	};
}
