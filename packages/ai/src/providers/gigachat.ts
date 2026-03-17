import type { GigaChatClientConfig } from "gigachat";
import GigaChat from "gigachat";
import type {
	ChatCompletionChunk,
	FunctionParameters,
	FunctionParametersProperty,
	Chat as GigaChatChat,
	Function as GigaChatFunction,
	Message as GigaChatMessage,
} from "gigachat/interfaces";
import { getEnvApiKey } from "../env-api-keys.js";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

const GIGACHAT_DEFAULT_MODEL = "GigaChat";

export interface GigaChatOptions extends StreamOptions {
	profanityCheck?: boolean;
	repetitionPenalty?: number;
	updateInterval?: number;
	functionCall?: "auto" | "none" | { name: string };
	scope?: string;
	baseUrl?: string;
	user?: string;
	password?: string;
}

type ToolCallBlock = ToolCall & { partialArgs?: string };
type GigaChatAuth =
	| { kind: "accessToken"; accessToken: string }
	| { kind: "credentials"; credentials: string; scope?: string }
	| { kind: "password"; user: string; password: string };

export const streamGigaChat: StreamFunction<"gigachat", GigaChatOptions> = (
	model: Model<"gigachat">,
	context: Context,
	options?: GigaChatOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createOutput(model);

		try {
			const auth = resolveAuth(model.provider, options);
			const client = createClient(model, auth, options);
			let payload = buildChatPayload(model, context, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload as GigaChatChat;
			}

			stream.push({ type: "start", partial: output });

			for await (const chunk of client.stream(payload, options?.signal)) {
				consumeChunk(output, stream, chunk);
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = await getErrorMessage(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleGigaChat: StreamFunction<"gigachat", SimpleStreamOptions> = (
	model: Model<"gigachat">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	resolveAuth(model.provider, options);
	return streamGigaChat(model, context, options);
};

function createOutput(model: Model<"gigachat">): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createClient(model: Model<"gigachat">, auth: GigaChatAuth, options?: GigaChatOptions): GigaChat {
	const config: GigaChatClientConfig = {};

	switch (auth.kind) {
		case "accessToken":
			config.accessToken = auth.accessToken;
			break;
		case "credentials":
			config.credentials = auth.credentials;
			config.scope = auth.scope;
			break;
		case "password":
			config.user = auth.user;
			config.password = auth.password;
			break;
	}

	config.model = model.id || GIGACHAT_DEFAULT_MODEL;
	config.baseUrl = options?.baseUrl || process.env.GIGACHAT_BASE_URL || model.baseUrl;
	config.profanityCheck = options?.profanityCheck;
	config.dangerouslyAllowBrowser = isBrowserRuntime();

	return new GigaChat(config);
}

function resolveAuth(provider: string, options?: GigaChatOptions): GigaChatAuth {
	const envApiKey = getEnvApiKey(provider);
	const apiKey = options?.apiKey || (envApiKey === "<authenticated>" ? undefined : envApiKey);
	if (apiKey) {
		if (isAccessToken(apiKey)) {
			return { kind: "accessToken", accessToken: apiKey };
		}
		return {
			kind: "credentials",
			credentials: apiKey,
			scope: options?.scope || process.env.GIGACHAT_SCOPE,
		};
	}

	const user = options?.user || process.env.GIGACHAT_USER;
	const password = options?.password || process.env.GIGACHAT_PASSWORD;
	if (user && password) {
		return { kind: "password", user, password };
	}

	throw new Error(`No authentication configured for provider: ${provider}`);
}

function buildChatPayload(model: Model<"gigachat">, context: Context, options?: GigaChatOptions): GigaChatChat {
	const payload: GigaChatChat = {
		model: model.id,
		messages: convertMessages(model, context),
		stream: true,
	};

	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
	if (options?.profanityCheck !== undefined) payload.profanity_check = options.profanityCheck;
	if (options?.repetitionPenalty !== undefined) payload.repetition_penalty = options.repetitionPenalty;
	if (options?.updateInterval !== undefined) payload.update_interval = options.updateInterval;
	if (context.tools?.length) payload.functions = convertFunctions(context.tools);
	if (options?.functionCall) payload.function_call = options.functionCall;

	return payload;
}

function consumeChunk(output: AssistantMessage, stream: AssistantMessageEventStream, chunk: ChatCompletionChunk): void {
	const choice = chunk.choices[0];
	if (!choice) return;

	if (choice.finish_reason) {
		output.stopReason = mapStopReason(choice.finish_reason);
	}

	const delta = choice.delta;

	if (delta.content) {
		let block = getCurrentTextBlock(output);
		if (!block) {
			block = { type: "text", text: "" };
			output.content.push(block);
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		}

		const textDelta = sanitizeSurrogates(delta.content);
		block.text += textDelta;
		stream.push({
			type: "text_delta",
			contentIndex: output.content.length - 1,
			delta: textDelta,
			partial: output,
		});
	}

	if (delta.function_call) {
		const currentText = getCurrentTextBlock(output);
		if (currentText) {
			stream.push({
				type: "text_end",
				contentIndex: output.content.length - 1,
				content: currentText.text,
				partial: output,
			});
		}

		let block = getCurrentToolCallBlock(output);
		if (!block) {
			block = {
				type: "toolCall",
				id: `gigachat_${output.content.filter((item) => item.type === "toolCall").length}`,
				name: "",
				arguments: {},
				partialArgs: "",
			};
			output.content.push(block);
			stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
		}

		if (delta.function_call.name) {
			block.name = delta.function_call.name;
		}
		if (delta.function_call.arguments) {
			block.arguments = mergeArguments(block.arguments, delta.function_call.arguments);
			block.partialArgs = JSON.stringify(block.arguments);
		}

		stream.push({
			type: "toolcall_delta",
			contentIndex: output.content.length - 1,
			delta: JSON.stringify(delta.function_call.arguments ?? {}),
			partial: output,
		});
	}

	finalizeCurrentBlocks(output, stream, choice.finish_reason);
}

function finalizeCurrentBlocks(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	finishReason: string | undefined,
): void {
	if (!finishReason) return;

	const lastBlock = output.content[output.content.length - 1];
	if (!lastBlock) return;

	if (lastBlock.type === "text") {
		stream.push({
			type: "text_end",
			contentIndex: output.content.length - 1,
			content: lastBlock.text,
			partial: output,
		});
		return;
	}

	if (lastBlock.type === "toolCall") {
		const toolCall = { ...lastBlock };
		delete (toolCall as ToolCallBlock).partialArgs;
		output.content[output.content.length - 1] = toolCall;
		stream.push({
			type: "toolcall_end",
			contentIndex: output.content.length - 1,
			toolCall,
			partial: output,
		});
	}
}

function convertMessages(model: Model<"gigachat">, context: Context): GigaChatMessage[] {
	const messages: GigaChatMessage[] = [];
	const transformedMessages = transformMessages(context.messages, model);
	const toolNameById = new Map<string, string>();

	if (context.systemPrompt) {
		messages.push({ role: "system", content: sanitizeSurrogates(context.systemPrompt) });
	}

	for (const message of transformedMessages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				messages.push({ role: "user", content: sanitizeSurrogates(message.content) });
			} else {
				const text = message.content
					.filter((item) => item.type === "text")
					.map((item) => sanitizeSurrogates(item.text))
					.join("\n");
				if (text.length > 0) {
					messages.push({ role: "user", content: text });
				}
			}
			continue;
		}

		if (message.role === "assistant") {
			const text = message.content
				.filter((item) => item.type === "text")
				.map((item) => sanitizeSurrogates(item.text))
				.join("");
			const toolCalls = message.content.filter((item) => item.type === "toolCall") as ToolCall[];

			for (const toolCall of toolCalls) {
				toolNameById.set(toolCall.id, toolCall.name);
			}

			if (toolCalls.length > 0) {
				const firstToolCall = toolCalls[0];
				messages.push({
					role: "assistant",
					content: text.length > 0 ? text : undefined,
					function_call: {
						name: firstToolCall.name,
						arguments: firstToolCall.arguments,
					},
				});
			} else {
				messages.push({ role: "assistant", content: text });
			}
			continue;
		}

		const toolMessage = message as ToolResultMessage;
		const text = toolMessage.content
			.filter((item) => item.type === "text")
			.map((item) => sanitizeSurrogates(item.text))
			.join("\n");
		messages.push({
			role: "function",
			name: toolMessage.toolName || toolNameById.get(toolMessage.toolCallId) || "function",
			content: JSON.stringify(text.length > 0 ? text : "(no content)"),
		});
	}

	return messages;
}

function convertFunctions(tools: Tool[]): GigaChatFunction[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: convertFunctionParameters(tool.parameters as unknown as Record<string, unknown>),
	}));
}

function convertFunctionParameters(schema: Record<string, unknown>): FunctionParameters | undefined {
	const type = asOptionalString(schema.type);
	const properties = asRecord(schema.properties);
	const required = Array.isArray(schema.required)
		? schema.required.filter((item): item is string => typeof item === "string")
		: undefined;

	if (!type && !properties && !required) {
		return undefined;
	}

	return {
		type,
		properties: properties ? convertFunctionProperties(properties) : undefined,
		required,
	};
}

function convertFunctionProperties(properties: Record<string, unknown>): Record<string, FunctionParametersProperty> {
	const result: Record<string, FunctionParametersProperty> = {};

	for (const [key, value] of Object.entries(properties)) {
		const property = asRecord(value);
		if (!property) continue;

		const items = asRecord(property.items);
		const nestedProperties = asRecord(property.properties);
		const enumValues = Array.isArray(property.enum)
			? property.enum.filter((item): item is string => typeof item === "string")
			: undefined;

		result[key] = {
			type: asOptionalString(property.type),
			description: asOptionalString(property.description),
			items: items ? convertUnknownRecord(items) : undefined,
			enum: enumValues,
			properties: nestedProperties ? convertFunctionProperties(nestedProperties) : undefined,
		};
	}

	return result;
}

function convertUnknownRecord(record: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (Array.isArray(value)) {
			result[key] = value;
		} else if (value && typeof value === "object") {
			result[key] = convertUnknownRecord(value as Record<string, unknown>);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function getCurrentTextBlock(output: AssistantMessage): TextContent | undefined {
	const lastBlock = output.content[output.content.length - 1];
	return lastBlock?.type === "text" ? lastBlock : undefined;
}

function getCurrentToolCallBlock(output: AssistantMessage): ToolCallBlock | undefined {
	const lastBlock = output.content[output.content.length - 1];
	return lastBlock?.type === "toolCall" ? (lastBlock as ToolCallBlock) : undefined;
}

function mergeArguments(current: Record<string, unknown>, delta: Record<string, unknown>): Record<string, unknown> {
	return { ...current, ...delta };
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "function_call":
			return "toolUse";
		case "blacklist":
		case "error":
			return "error";
		default:
			return "stop";
	}
}

function isAccessToken(value: string): boolean {
	return value.split(".").length >= 3;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

async function getErrorMessage(error: unknown): Promise<string> {
	if (error instanceof Error && error.message && error.message !== "[object ReadableStream]") {
		if (error.message !== "[object Object]") {
			return error.message;
		}
	}

	const response = asRecord(error)?.response;
	if (response) {
		const responseError = extractResponseErrorMessage(await readResponseData(asRecord(response)?.data));
		if (responseError) {
			return responseError;
		}
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function extractResponseErrorMessage(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}

	const record = asRecord(value);
	if (!record) {
		return undefined;
	}

	for (const key of ["message", "error", "detail"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate;
		}
	}

	return undefined;
}

function isBrowserRuntime(): boolean {
	const scope = globalThis as { window?: unknown; document?: unknown };
	return typeof scope.window !== "undefined" && typeof scope.document !== "undefined";
}

async function readResponseData(value: unknown): Promise<unknown> {
	if (typeof value === "string") {
		return tryParseJson(value);
	}

	const webStream = asReadableStream(value);
	if (webStream) {
		const reader = webStream.getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
			if (chunk) chunks.push(chunk);
		}
		const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const merged = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		return tryParseJson(new TextDecoder().decode(merged));
	}

	const nodeStream = asNodeReadable(value);
	if (nodeStream) {
		let body = "";
		for await (const chunk of nodeStream) {
			body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		}
		return tryParseJson(body);
	}

	return value;
}

function tryParseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function asReadableStream(value: unknown): ReadableStream<Uint8Array> | undefined {
	if (typeof ReadableStream === "undefined") {
		return undefined;
	}
	return value instanceof ReadableStream ? value : undefined;
}

function asNodeReadable(value: unknown): AsyncIterable<Uint8Array | string> | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return Symbol.asyncIterator in value ? (value as AsyncIterable<Uint8Array | string>) : undefined;
}
