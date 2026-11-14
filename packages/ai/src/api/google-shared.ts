/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import type {
	Content,
	FinishReason,
	FunctionCallingConfigMode,
	GenerateContentResponsePromptFeedback,
	GenerateContentResponseUsageMetadata,
	ThinkingLevel as GoogleSdkThinkingLevel,
	Part,
	ThinkingConfig,
} from "@google/genai";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	ImageContent,
	Model,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingLevel,
	Tool,
	TranscriptContext,
} from "../types.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { collapseSystemMessages, withoutInitialSystemMessage } from "../utils/transcript.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Thinking level for Gemini models that use `thinkingLevel` instead of `thinkingBudget`.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "max">;

// Keep shared wire helpers independent of the SDK runtime. Type-check its enum values.
const GOOGLE_SDK_THINKING_LEVEL_MAP = {
	THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
	MINIMAL: "MINIMAL",
	LOW: "LOW",
	MEDIUM: "MEDIUM",
	HIGH: "HIGH",
	XHIGH: "XHIGH",
} satisfies Record<GoogleApiThinkingLevel, `${GoogleSdkThinkingLevel}`>;

const GOOGLE_FUNCTION_CALLING_MODES = {
	AUTO: "AUTO",
	NONE: "NONE",
	ANY: "ANY",
	VALIDATED: "VALIDATED",
} satisfies Record<string, `${FunctionCallingConfigMode}`>;

/** Resolve a supported pi level or model-specific Google mapping to a standard Google level. */
export function resolveGoogleThinkingLevel<T extends Api>(
	model: Model<T>,
	level: ThinkingLevel,
): ResolvedGoogleThinkingLevel {
	const mapped = model.thinkingLevelMap?.[level];
	const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
	switch (resolvedLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return resolvedLevel;
		default:
			throw new Error(
				`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
			);
	}
}

/**
 * Whether this model uses Gemini's discrete `thinkingLevel` control instead of
 * the token-based `thinkingBudget` control. Supported levels come from the
 * model's `thinkingLevelMap`; this only selects the Google wire format.
 */
export function usesGoogleThinkingLevel<T extends Api>(model: Model<T>): boolean {
	const id = model.id.toLowerCase();
	return (
		// Match Gemini 3 Pro/Flash IDs with or without a minor version, such as
		// gemini-3-flash-preview, gemini-3.1-pro-preview, and gemini-3.8-flash.
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		// Match Gemini 4 and later, such as gemini-4-argon (#10890).
		(getGeminiMajorVersion(id) ?? 0) >= 4 ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest" ||
		// Match both hosted Gemma 4 naming forms: gemma-4-* and gemma4-*.
		/gemma-?4/.test(id)
	);
}

export function toGoogleThinkingLevel(level: ResolvedGoogleThinkingLevel): GoogleApiThinkingLevel {
	switch (level) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
		case "xhigh":
			return "XHIGH";
	}
}

/** Token budget for Gemini models that use `thinkingBudget`: custom budgets first, then per-model defaults, else -1 (dynamic). */
export function getGoogleBudget<T extends GoogleApiType>(
	model: Model<T>,
	resolvedLevel: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	// Budgets stop at high, so xhigh uses the high budget.
	const level = resolvedLevel === "xhigh" ? "high" : resolvedLevel;
	const customBudget = customBudgets?.[level];
	if (customBudget !== undefined) return customBudget;

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<keyof ThinkingBudgets, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<keyof ThinkingBudgets, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<keyof ThinkingBudgets, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	return -1;
}

export function toGoogleSdkThinkingLevel(level: GoogleApiThinkingLevel): GoogleSdkThinkingLevel {
	return GOOGLE_SDK_THINKING_LEVEL_MAP[level] as GoogleSdkThinkingLevel;
}

export function getDisabledGoogleThinkingConfig<T extends Api>(model: Model<T>): ThinkingConfig {
	if (!usesGoogleThinkingLevel(model)) return { thinkingBudget: 0 };

	const fallback = clampThinkingLevel(model, "off");
	if (fallback === "off") return { thinkingBudget: 0 };

	const resolvedLevel = resolveGoogleThinkingLevel(model, fallback);
	const apiLevel = toGoogleThinkingLevel(resolvedLevel);
	return { thinkingLevel: toGoogleSdkThinkingLevel(apiLevel) };
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
export function resolveThoughtSignature(
	isSameProviderAndModel: boolean,
	signature: string | undefined,
): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Google's documented bypass value for a function call the current model did not sign, base64-encoded
 * because thoughtSignature is a bytes field (the raw string was reported to fail on Vertex in #4032).
 * Gemini 3+ rejects a model turn whose function calls carry no signature (400 "Function call is missing a
 * thought_signature"), which happens on history from another provider, whose signatures are dropped.
 */
const SKIP_THOUGHT_SIGNATURE_VALIDATOR_B64 = "c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=";

/** Whether Gemini enforces a thought signature on the first function call of each model turn (Gemini 3+). */
export function requiresFunctionCallThoughtSignature(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return geminiMajorVersion !== undefined && geminiMajorVersion >= 3;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}

export function getGeminiMajorVersion(modelId: string): number | undefined {
	// Unanchored like usesGoogleThinkingLevel: some hosts prefix the ID, e.g. randomprefix-gemini-4-argon (#12321).
	const match = modelId.toLowerCase().match(/gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

export function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: TranscriptContext): Content[] {
	// Gemini has no mid-conversation system messages; the leading prompt is sent as systemInstruction.
	const conversation = withoutInitialSystemMessage(collapseSystemMessages(context).messages);
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(conversation, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
			// transformMessages already dropped tool call signatures that do not carry over to this model.
			const isSameProvider = msg.provider === model.provider && msg.api === model.api;

			for (const block of msg.content) {
				if (block.type === "text") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					// Skip empty text blocks — unless they carry a thought signature. Gemini can attach
					// the signature to a part whose visible text is empty and requires it echoed back;
					// dropping it breaks the reasoning chain and the model intermittently ends mid-task
					// turns with a thought-only STOP (empty completion, no tool call).
					if ((!block.text || block.text.trim() === "") && !thoughtSignature) continue;
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Only keep as thinking block if same provider AND same model
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						// Same rule as text blocks: an empty thinking block is dropped only when it
						// carries no signature (mirrors the anthropic converter's handling).
						if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						// Cross-provider/model: the signature is unusable, empty blocks stay dropped.
						if (!block.thinking || block.thinking.trim() === "") continue;
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProvider, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			// Only the first call of a parallel group is signed by Gemini, so one signature per turn is the
			// valid shape; add the bypass only when no call in this turn kept a signature.
			const functionCallParts = parts.filter((part) => part.functionCall !== undefined);
			if (
				requiresFunctionCallThoughtSignature(model.id) &&
				functionCallParts.length > 0 &&
				!functionCallParts.some((part) => part.thoughtSignature)
			) {
				functionCallParts[0].thoughtSignature = SKIP_THOUGHT_SIGNATURE_VALIDATOR_B64;
			}
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.trim().length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, add images in a separate user message
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 equivalent of $defs
]);

/**
 * Strip meta-declarations from a schema obj
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/** Schema keywords whose values map names to subschemas, so their keys are not schema keywords. */
const JSON_SCHEMA_NAME_MAPS = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
	"dependencies",
]);

/** Keywords containing a subschema or an array of subschemas, not literal data. */
const JSON_SCHEMA_SUBSCHEMAS = new Set([
	"additionalProperties",
	"unevaluatedProperties",
	"propertyNames",
	"items",
	"prefixItems",
	"additionalItems",
	"unevaluatedItems",
	"contains",
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"contentSchema",
]);

/**
 * Rewrite string and number `const` values to single-value `enum`s.
 * Gemini ignores `const` in `parametersJsonSchema` but honors `enum`.
 */
export function rewriteConstAsEnum(schema: unknown, isNameMap = false): unknown {
	if (Array.isArray(schema)) return schema.map((item) => rewriteConstAsEnum(item));
	if (typeof schema !== "object" || schema === null) return schema;

	// fromEntries preserves names such as __proto__ as own properties.
	const result: Record<string, unknown> = Object.fromEntries(
		Object.entries(schema).map(([key, value]) => {
			if (isNameMap || JSON_SCHEMA_SUBSCHEMAS.has(key)) return [key, rewriteConstAsEnum(value)];
			if (JSON_SCHEMA_NAME_MAPS.has(key)) return [key, rewriteConstAsEnum(value, true)];
			return [key, value];
		}),
	);
	if (!isNameMap && "const" in result && result.enum === undefined) {
		const value = result.const;
		if (typeof value === "string" || typeof value === "number") {
			delete result.const;
			result.enum = [value];
		}
	}
	return result;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, etc.). Gemini ignores `const` there, so string and number `const`
 * values are sent as single-value `enum`s. Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
	supportsStrictMode = true,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => {
				const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
				const parameters = getJsonSchemaToolParameters(tool, strict);
				return {
					name: tool.name,
					description: tool.description,
					...(useParameters
						? { parameters: sanitizeForOpenApi(parameters as unknown) }
						: { parametersJsonSchema: rewriteConstAsEnum(parameters) }),
				};
			}),
		},
	];
}

/**
 * Gemini 3+ enforces required function parameters in validated tool-calling modes.
 * `compat.supportsStrictMode` overrides the model ID detection, e.g. for Gemini models served under IDs without the version.
 */
export function supportsGoogleStrictToolSampling<T extends GoogleApiType>(model: Model<T>): boolean {
	const majorVersion = getGeminiMajorVersion(model.id);
	return model.compat?.supportsStrictMode ?? (majorVersion !== undefined && majorVersion >= 3);
}

/** Map tool choice string to Gemini FunctionCallingConfigMode. */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return GOOGLE_FUNCTION_CALLING_MODES.AUTO as FunctionCallingConfigMode;
		case "none":
			return GOOGLE_FUNCTION_CALLING_MODES.NONE as FunctionCallingConfigMode;
		case "any":
			return GOOGLE_FUNCTION_CALLING_MODES.ANY as FunctionCallingConfigMode;
		default:
			return GOOGLE_FUNCTION_CALLING_MODES.AUTO as FunctionCallingConfigMode;
	}
}

export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	const useStrictMode = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
	if (toolChoice === "none" || toolChoice === "any") {
		return mapToolChoice(toolChoice);
	}
	if (useStrictMode) {
		return GOOGLE_FUNCTION_CALLING_MODES.VALIDATED as FunctionCallingConfigMode;
	}
	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}

/** Format prompt-block metadata returned instead of response candidates. */
export function formatGooglePromptBlockError(
	providerName: string,
	feedback: GenerateContentResponsePromptFeedback,
): string {
	const details = [`${providerName} prompt blocked: ${feedback.blockReason ?? "unknown reason"}`];
	if (feedback.blockReasonMessage) details.push(feedback.blockReasonMessage);
	if (feedback.safetyRatings?.length) {
		const ratings = feedback.safetyRatings.flatMap((rating) =>
			rating.category ? [`${rating.category}${rating.probability ? ` (${rating.probability})` : ""}`] : [],
		);
		if (ratings.length > 0) {
			details.push(`Safety rating${ratings.length === 1 ? "" : "s"}: ${ratings.join(", ")}`);
		}
	}
	return details.join(". ");
}

/**
 * Context tokens after a turn. Across continuation hops the SDK sums promptTokenCount, and each
 * later hop's prompt repeats the first prompt plus the output so far, which output already counts.
 */
export function googleContextTokens(usage: GenerateContentResponseUsageMetadata): number {
	const total = usage.totalTokenCount || 0;
	const initialPrompt = usage.initialPromptTokenCount;
	return initialPrompt === undefined ? total : total - ((usage.promptTokenCount || 0) - initialPrompt);
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: `${FinishReason}`): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
		// The SDK resumes CONTINUATION stops with their token; one reaches pi only when the hop ended
		// without a new token, so the output is cut short like MAX_TOKENS.
		case "CONTINUATION":
			return "length";
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "SAFETY":
		case "IMAGE_SAFETY":
		case "IMAGE_PROHIBITED_CONTENT":
		case "IMAGE_RECITATION":
		case "IMAGE_OTHER":
		case "RECITATION":
		case "FINISH_REASON_UNSPECIFIED":
		case "OTHER":
		case "LANGUAGE":
		case "MALFORMED_FUNCTION_CALL":
		case "MALFORMED_RESPONSE" as `${FinishReason}`:
		case "UNEXPECTED_TOOL_CALL":
		case "TOO_MANY_TOOL_CALLS":
		case "NO_IMAGE":
		case "MISSING_THOUGHT_SIGNATURE":
		case "MALFORMED_RESPONSE":
		case "ESCALATION":
		case "PUP_LIMITED_DISABLED":
		case "MODEL_ARMOR":
			return "error";
		default: {
			return "error";
		}
	}
}

/**
 * Run a Google GenAI SDK request with the shared provider retry policy
 * (408/409/429/5xx with backoff, honoring retry-after), mirroring how the
 * Anthropic and OpenAI adapters wrap their initial request in
 * retryProviderRequest. The SDK's ApiError has a `status` property but no
 * `headers` property, and retryProviderRequest only retries errors that carry
 * both, so normalize the error by adding the missing `headers` before
 * rethrowing.
 */
export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					(error as { headers?: Headers }).headers = undefined;
				}
				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
}
