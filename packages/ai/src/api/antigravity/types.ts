// Adapted from pi-antigravity (MIT), Copyright (c) 2026 Rahul Arya.
// See LICENSE in this directory.
import type { SimpleStreamOptions, TextContent, ThinkingContent, ToolCall } from "../../types.ts";
import type { GeminiRole, GeminiToolCallingMode, ThinkingEffort, ToolChoice } from "./enums.ts";

export type AntigravityApiKey = {
	token: string;
	projectId: string;
};

export type DynamicModelInfo = {
	id: string;
	experiments?: string[];
	apiProvider?: string;
	modelProvider?: string;
	model?: string;
};

// Model Types
export type AntigravityRouting = {
	off?: string;
	routing?: Partial<Record<ThinkingEffort, string>>;
	defaultRequestId?: string;
};

// Stream & API Types
export const ANTIGRAVITY_API = "antigravity-api" as const;
export type AntigravityApi = typeof ANTIGRAVITY_API;

export type AntigravityStreamOptions = Omit<SimpleStreamOptions, "toolChoice"> & {
	toolChoice?: ToolChoice;
	runtimeModel?: string;
	modelEnum?: string;
};

export type GeminiTextPart = { text: string; thoughtSignature?: string };
export type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
export type GeminiThoughtPart = {
	thought: true;
	text: string;
	thoughtSignature?: string;
};
export type GeminiFunctionCallPart = {
	functionCall: {
		name: string;
		args: Record<string, unknown>;
		id?: string;
	};
	thoughtSignature?: string;
};
export type GeminiFunctionResponsePart = {
	functionResponse: {
		name: string;
		response: { error: string } | { output: string };
		parts?: GeminiInlineDataPart[];
		id?: string;
	};
};
export type GeminiPart =
	| GeminiTextPart
	| GeminiInlineDataPart
	| GeminiThoughtPart
	| GeminiFunctionCallPart
	| GeminiFunctionResponsePart;

export type GeminiContent = {
	role: GeminiRole;
	parts: GeminiPart[];
};

export type GeminiFunctionDeclaration = {
	name: string;
	description: string;
	parameters?: unknown;
	parametersJsonSchema?: unknown;
};

export type GeminiToolConfig = {
	functionCallingConfig: {
		mode: GeminiToolCallingMode;
	};
};

export type ThinkingWire = {
	includeThoughts: boolean;
	thinkingBudget?: number;
	thinkingLevel?: string;
};

export type GeminiGenerationConfig = {
	temperature?: number;
	maxOutputTokens?: number;
	thinkingConfig?: ThinkingWire;
};

export type GeminiRequestBody = {
	contents: GeminiContent[];
	systemInstruction: {
		role: "user";
		parts: GeminiTextPart[];
	};
	generationConfig?: GeminiGenerationConfig;
	tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
	toolConfig?: GeminiToolConfig;
	sessionId?: string;
	labels?: Record<string, string>;
};

export type AntigravityGenerateRequest = {
	project: string;
	model: string;
	request: GeminiRequestBody;
	requestType: "agent";
	userAgent: "antigravity";
	requestId: string;
};

export type StreamPart = {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: {
		id?: string;
		name?: string;
		args?: Record<string, unknown>;
	};
};

export type StreamUsageMetadata = {
	promptTokenCount?: number;
	cachedContentTokenCount?: number;
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
	totalTokenCount?: number;
};

export type StreamCandidate = {
	content?: { parts?: StreamPart[] };
	finishReason?: string;
};

export type StreamResponseData = {
	candidates?: StreamCandidate[];
	usageMetadata?: StreamUsageMetadata;
};

export type StreamChunk = StreamResponseData & {
	error?: { message?: string };
	response?: StreamResponseData;
};

export type LooseImageBlock = {
	type: "image";
	data?: string;
	mimeType?: string;
	mediaType?: string;
	source?: { data?: string; mediaType?: string };
};

export type ContentBlock = TextContent | ThinkingContent | ToolCall | LooseImageBlock;

export type ActiveTextBlock = TextContent;
export type ActiveThinkingBlock = ThinkingContent;
export type ActiveBlock = ActiveTextBlock | ActiveThinkingBlock;

// Model discovery metadata.
export type ModelInfoRaw = {
	isInternal?: unknown;
	displayName?: unknown;
	/** Catalog badge, e.g. "New", "Fast", "Leaving Soon". */
	tagTitle?: unknown;
	label?: unknown;
	modelName?: unknown;
	model?: unknown;
	modelProvider?: unknown;
	apiProvider?: unknown;
	supportsThinking?: unknown;
	supportsImages?: unknown;
	maxTokens?: unknown;
	maxOutputTokens?: unknown;
	recommended?: unknown;
	quotaInfo?: {
		remainingFraction?: unknown;
		resetTime?: unknown;
	};
};

export type AvailableModelsRaw = {
	models?: Record<string, ModelInfoRaw>;
	defaultAgentModelId?: unknown;
	defaultAgentModel?: unknown;
};
