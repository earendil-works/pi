import { getApiProvider } from "./api-registry.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
	ToolCall,
	Usage,
} from "./types.ts";
import { createAssistantMessageEventStream } from "./utils/event-stream.ts";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider, options?.env);
	if (!apiKey) return options;
	return { ...options, apiKey } as TOptions;
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStrictToolArguments(rawArguments: string): { arguments: Record<string, unknown> } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawArguments);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	if (!isJsonObject(parsed)) {
		return { error: "Tool call arguments must be a JSON object" };
	}
	return { arguments: parsed };
}

function createStreamErrorMessage(
	model: Model<Api>,
	partialMessage: AssistantMessage | undefined,
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: partialMessage?.content ?? [],
		api: partialMessage?.api ?? model.api,
		provider: partialMessage?.provider ?? model.provider,
		model: partialMessage?.model ?? model.id,
		responseModel: partialMessage?.responseModel,
		responseId: partialMessage?.responseId,
		diagnostics: partialMessage?.diagnostics,
		usage: partialMessage?.usage ?? emptyUsage(),
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function replaceToolCallArguments(
	message: AssistantMessage,
	finalArguments: Map<number, Record<string, unknown>>,
): AssistantMessage {
	if (finalArguments.size === 0) return message;
	let changed = false;
	const content = message.content.map((block, index) => {
		const argumentsForBlock = finalArguments.get(index);
		if (!argumentsForBlock || block.type !== "toolCall") return block;
		changed = true;
		return { ...block, arguments: argumentsForBlock };
	});
	return changed ? { ...message, content } : message;
}

function replaceToolCallInPartial(
	message: AssistantMessage,
	contentIndex: number,
	toolCall: ToolCall,
): AssistantMessage {
	const existing = message.content[contentIndex];
	if (!existing || existing.type !== "toolCall") return message;
	const content = [...message.content];
	content[contentIndex] = toolCall;
	return { ...message, content };
}

function getToolCallName(message: AssistantMessage, contentIndex: number): string {
	const block = message.content[contentIndex];
	if (!block || block.type !== "toolCall") return `content index ${contentIndex}`;
	return `${block.name} (${block.id})`;
}

function validateFinalToolArgumentsStream<TApi extends Api>(
	model: Model<TApi>,
	source: AssistantMessageEventStream,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const rawArgumentsByIndex = new Map<number, string>();
	const finalArgumentsByIndex = new Map<number, Record<string, unknown>>();
	let lastPartial: AssistantMessage | undefined;

	void (async () => {
		try {
			for await (const event of source) {
				if ("partial" in event) {
					lastPartial = event.partial;
				}

				if (event.type === "toolcall_delta") {
					rawArgumentsByIndex.set(
						event.contentIndex,
						(rawArgumentsByIndex.get(event.contentIndex) ?? "") + event.delta,
					);
					stream.push(event);
					continue;
				}

				if (event.type === "toolcall_end") {
					const rawArguments = rawArgumentsByIndex.get(event.contentIndex);
					if (rawArguments !== undefined) {
						const parseResult = parseStrictToolArguments(rawArguments);
						if ("error" in parseResult) {
							const errorMessage = `Invalid final tool call arguments for ${getToolCallName(
								event.partial,
								event.contentIndex,
							)}: ${parseResult.error}`;
							stream.push({
								type: "error",
								reason: "error",
								error: createStreamErrorMessage(model, event.partial, errorMessage),
							});
							return;
						}
						finalArgumentsByIndex.set(event.contentIndex, parseResult.arguments);
						const toolCall = { ...event.toolCall, arguments: parseResult.arguments };
						stream.push({
							...event,
							toolCall,
							partial: replaceToolCallInPartial(event.partial, event.contentIndex, toolCall),
						});
						continue;
					}
				}

				if (event.type === "done") {
					const message = replaceToolCallArguments(event.message, finalArgumentsByIndex);
					const unexpectedToolCall = message.content.find((block) => block.type === "toolCall");
					if (unexpectedToolCall && event.reason !== "toolUse") {
						stream.push({
							type: "error",
							reason: "error",
							error: createStreamErrorMessage(
								model,
								message,
								`Tool call ${unexpectedToolCall.name} (${unexpectedToolCall.id}) ended with stop reason ${event.reason}`,
							),
						});
						return;
					}
					stream.push({ ...event, message });
					return;
				}

				if (event.type === "error") {
					stream.push(event);
					return;
				}

				stream.push(event);
			}

			const finalMessage = replaceToolCallArguments(await source.result(), finalArgumentsByIndex);
			stream.end(finalMessage);
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: createStreamErrorMessage(model, lastPartial, error instanceof Error ? error.message : String(error)),
			});
		}
	})();

	return stream;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return validateFinalToolArgumentsStream(
		model,
		provider.stream(model, context, withEnvApiKey(model, options) as StreamOptions),
	);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return validateFinalToolArgumentsStream(model, provider.streamSimple(model, context, withEnvApiKey(model, options)));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
