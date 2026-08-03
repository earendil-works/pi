import {
	type ImageContent as AiImageContent,
	type TextContent as AiTextContent,
	type Usage as AiUsage,
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ModelMetadata,
	ThinkingLevel,
	ToolTranscriptItem,
	Usage,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";

type Assert<T extends true> = T;
type ExactKeys<T, Keys extends keyof T> = keyof T extends Keys ? true : false;
type _AiThinkingLevelsFitProtocol = Assert<ModelThinkingLevel extends ThinkingLevel ? true : false>;
type _ProtocolThinkingLevelsFitAi = Assert<ThinkingLevel extends ModelThinkingLevel ? true : false>;
type AiModelInput = Model<Api>["input"][number];
type ProtocolModelInput = ModelMetadata["input"][number];
type _AiModelInputsFitProtocol = Assert<AiModelInput extends ProtocolModelInput ? true : false>;
type _ProtocolModelInputsFitAi = Assert<ProtocolModelInput extends AiModelInput ? true : false>;
/**
 * Enumerate mapped and intentionally omitted pi-ai fields so additions fail compilation here.
 * Provider replay metadata, diagnostics, cache-write retention splits, model transport settings,
 * pricing tiers, and deferred-tool availability remain intentionally server-side.
 */
type _AiTextContentFieldsAccountedFor = Assert<ExactKeys<AiTextContent, "type" | "text" | "textSignature">>;
type _AiThinkingContentFieldsAccountedFor = Assert<
	ExactKeys<
		Extract<AssistantMessage["content"][number], { type: "thinking" }>,
		"type" | "thinking" | "thinkingSignature" | "redacted"
	>
>;
type _AiImageContentFieldsAccountedFor = Assert<ExactKeys<AiImageContent, "type" | "data" | "mimeType">>;
type _AiToolCallFieldsAccountedFor = Assert<
	ExactKeys<ToolCall, "type" | "id" | "name" | "arguments" | "thoughtSignature">
>;
type _AiUsageFieldsAccountedFor = Assert<
	ExactKeys<
		AiUsage,
		"input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "reasoning" | "totalTokens" | "cost"
	>
>;
type _AiUsageCostFieldsAccountedFor = Assert<
	ExactKeys<AiUsage["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "total">
>;
type _AiModelFieldsAccountedFor = Assert<
	ExactKeys<
		Model<Api>,
		| "id"
		| "name"
		| "api"
		| "provider"
		| "baseUrl"
		| "reasoning"
		| "thinkingLevelMap"
		| "input"
		| "cost"
		| "contextWindow"
		| "maxTokens"
		| "headers"
		| "compat"
	>
>;
type _AiModelCostFieldsAccountedFor = Assert<
	ExactKeys<Model<Api>["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "tiers">
>;
type _AiUserMessageFieldsAccountedFor = Assert<ExactKeys<UserMessage, "role" | "content" | "timestamp">>;
type _AiAssistantMessageFieldsAccountedFor = Assert<
	ExactKeys<
		AssistantMessage,
		| "role"
		| "content"
		| "api"
		| "provider"
		| "model"
		| "responseModel"
		| "responseId"
		| "diagnostics"
		| "usage"
		| "stopReason"
		| "errorMessage"
		| "rawStopReason"
		| "timestamp"
	>
>;
type _AiToolResultMessageFieldsAccountedFor = Assert<
	ExactKeys<
		ToolResultMessage,
		"role" | "toolCallId" | "toolName" | "content" | "details" | "usage" | "addedToolNames" | "isError" | "timestamp"
	>
>;

export interface AssistantTranscriptOptions {
	id: string;
}

export interface UserTranscriptOptions {
	id: string;
}

export interface ToolTranscriptOptions {
	id: string;
	call: ToolCall;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

function nonNegativeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function identifier(value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function timestamp(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Protocol timestamps must be non-negative integers");
	return value;
}

/** Validate and copy a value from an execution boundary into the protocol's JSON-compatible subset. */
export function toProtocolJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Protocol JSON numbers must be finite");
		return value;
	}
	if (typeof value !== "object") throw new TypeError(`Unsupported protocol JSON value: ${typeof value}`);
	if (seen.has(value)) throw new TypeError("Protocol JSON values must not contain circular references");
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Protocol JSON objects must be plain objects");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) return Array.from(value, (entry) => toProtocolJsonValue(entry, seen));
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) result[key] = toProtocolJsonValue(entry, seen);
		return result;
	} finally {
		seen.delete(value);
	}
}

/** Lossily sanitize diagnostic tool details that must not affect execution semantics. */
export function sanitizeProtocolDetails(value: unknown, seen = new Set<object>()): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return Array.from(value, (entry) => sanitizeProtocolDetails(entry, seen) ?? null);
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			const normalized = sanitizeProtocolDetails(entry, seen);
			if (normalized !== undefined) result[key] = normalized;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

export function toProtocolUsage(usage: AiUsage | undefined): Usage | undefined {
	if (!usage) return undefined;
	const reasoning = nonNegativeInteger(usage.reasoning);
	const result = {
		input: nonNegativeInteger(usage.input) ?? 0,
		output: nonNegativeInteger(usage.output) ?? 0,
		cacheRead: nonNegativeInteger(usage.cacheRead) ?? 0,
		cacheWrite: nonNegativeInteger(usage.cacheWrite) ?? 0,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: nonNegativeInteger(usage.totalTokens) ?? 0,
		cost: {
			input: nonNegativeNumber(usage.cost.input),
			output: nonNegativeNumber(usage.cost.output),
			cacheRead: nonNegativeNumber(usage.cost.cacheRead),
			cacheWrite: nonNegativeNumber(usage.cost.cacheWrite),
			total: nonNegativeNumber(usage.cost.total),
		},
	} satisfies Usage;
	return result;
}

export function toProtocolModelMetadata(model: Model<Api>, authenticated: boolean): ModelMetadata {
	const result = {
		provider: identifier(model.provider, "Model provider"),
		id: identifier(model.id, "Model id"),
		name: identifier(model.name, "Model name"),
		api: identifier(model.api, "Model API"),
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: Math.max(1, Math.floor(model.contextWindow)),
		maxTokens: Math.max(1, Math.floor(model.maxTokens)),
		cost: {
			input: nonNegativeNumber(model.cost.input),
			output: nonNegativeNumber(model.cost.output),
			cacheRead: nonNegativeNumber(model.cost.cacheRead),
			cacheWrite: nonNegativeNumber(model.cost.cacheWrite),
		},
		supportedThinkingLevels: getSupportedThinkingLevels(model),
		authenticated,
	} satisfies ModelMetadata;
	return result;
}

function toProtocolUserContent(content: UserMessage["content"]): UserTranscriptItem["content"] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "image":
				return { type: "image", data: part.data, mimeType: part.mimeType };
			default: {
				const exhaustive: never = part;
				return exhaustive;
			}
		}
	});
}

export function toProtocolUserMessage(message: UserMessage, options: UserTranscriptOptions): UserTranscriptItem {
	const result = {
		id: identifier(options.id, "Transcript item id"),
		role: "user",
		content: toProtocolUserContent(message.content),
		timestamp: timestamp(message.timestamp),
	} satisfies UserTranscriptItem;
	return result;
}

function toProtocolAssistantContent(message: AssistantMessage): AssistantTranscriptItem["content"] {
	return message.content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "thinking":
				return {
					type: "thinking",
					thinking: part.thinking,
					...(part.redacted === undefined ? {} : { redacted: part.redacted }),
				};
			case "toolCall":
				return {
					type: "toolCall",
					toolCallId: identifier(part.id, "Tool call id"),
					toolName: identifier(part.name, "Tool call name"),
					input: toProtocolJsonValue(part.arguments),
				};
			default: {
				const exhaustive: never = part;
				return exhaustive;
			}
		}
	});
}

export function toProtocolAssistantMessage(
	message: AssistantMessage,
	options: AssistantTranscriptOptions,
): AssistantTranscriptItem {
	const usage = toProtocolUsage(message.usage);
	const common = {
		id: identifier(options.id, "Transcript item id"),
		role: "assistant",
		content: toProtocolAssistantContent(message),
		model: {
			provider: identifier(message.provider, "Assistant provider"),
			id: identifier(message.model, "Assistant model"),
		},
		...(message.responseModel === undefined
			? {}
			: { responseModel: identifier(message.responseModel, "Assistant response model") }),
		...(usage ? { usage } : {}),
		timestamp: timestamp(message.timestamp),
	} as const;
	switch (message.stopReason) {
		case "pending":
			return { ...common, status: "streaming" } satisfies AssistantTranscriptItem;
		case "stop":
		case "length":
		case "toolUse":
			return {
				...common,
				status: "complete",
				stopReason: message.stopReason,
			} satisfies AssistantTranscriptItem;
		case "error":
			if (message.errorMessage?.length === 0) {
				throw new TypeError("Assistant error messages must not be empty");
			}
			return {
				...common,
				status: "error",
				stopReason: "error",
				...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			} satisfies AssistantTranscriptItem;
		case "aborted":
			return {
				...common,
				status: "aborted",
				stopReason: "aborted",
				...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			} satisfies AssistantTranscriptItem;
		default: {
			const exhaustive: never = message.stopReason;
			return exhaustive;
		}
	}
}

function toProtocolToolContent(content: Array<AiTextContent | AiImageContent>): ToolTranscriptItem["content"] {
	return content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "image":
				return { type: "image", data: part.data, mimeType: part.mimeType };
			default: {
				const exhaustive: never = part;
				return exhaustive;
			}
		}
	});
}

export function toProtocolToolResultMessage(
	message: ToolResultMessage,
	options: ToolTranscriptOptions,
): ToolTranscriptItem {
	const callId = identifier(options.call.id, "Tool call id");
	const callName = identifier(options.call.name, "Tool call name");
	if (identifier(message.toolCallId, "Tool result call id") !== callId) {
		throw new TypeError(`Tool result ${message.toolCallId} does not match tool call ${callId}`);
	}
	if (identifier(message.toolName, "Tool result name") !== callName) {
		throw new TypeError(`Tool result ${message.toolName} does not match tool call ${callName}`);
	}
	const details = sanitizeProtocolDetails(message.details);
	const usage = toProtocolUsage(message.usage);
	const common = {
		id: identifier(options.id, "Transcript item id"),
		role: "tool",
		toolCallId: callId,
		toolName: callName,
		input: toProtocolJsonValue(options.call.arguments),
		content: toProtocolToolContent(message.content),
		...(details === undefined ? {} : { details }),
		...(usage ? { usage } : {}),
		timestamp: timestamp(message.timestamp),
	} as const;
	return message.isError
		? ({ ...common, status: "error", isError: true } satisfies ToolTranscriptItem)
		: ({ ...common, status: "complete", isError: false } satisfies ToolTranscriptItem);
}
