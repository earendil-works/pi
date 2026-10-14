/*!
 * Adapted from pi-antigravity 0.9.0.
 * MIT License
 *
 * Copyright (c) 2026 Rahul Arya
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { calculateCost } from "../../models.ts";
import type { AntigravityModel } from "../../providers/antigravity.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	TranscriptContext as Context,
	Model,
	ProviderEnv,
	TextContent,
	Tool,
	ToolCall,
} from "../../types.ts";
import { createAssistantMessageEventStream } from "../../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../../utils/headers.ts";
import { sleep } from "../../utils/sleep.ts";
import { getCurrentSystemPrompt, getCurrentTools } from "../../utils/transcript.ts";
import {
	antigravityHeaders,
	endpointCandidates,
	fetchAvailableRuntimeModel,
	jsonOrTextError,
	loadCodeAssist,
	parseApiKey,
	resolveProjectId,
} from "./client.ts";
import {
	AntigravityRequestType,
	AntigravityUserAgent,
	GeminiRole,
	GeminiToolCallingMode,
	StopReason,
	ToolChoice,
} from "./enums.ts";
import {
	ANTIGRAVITY_ROUTING,
	getAntigravityRequestModelId,
	getFallbackRuntimeModel,
	getMaxOutputTokens,
	getThinkingConfig,
} from "./models.ts";
import { redactSecrets, safeError } from "./security.ts";
import {
	type ActiveBlock,
	ANTIGRAVITY_API,
	type AntigravityGenerateRequest,
	type AntigravityStreamOptions,
	type ContentBlock,
	type GeminiContent,
	type GeminiFunctionDeclaration,
	type GeminiFunctionResponsePart,
	type GeminiGenerationConfig,
	type GeminiInlineDataPart,
	type GeminiPart,
	type GeminiRequestBody,
	type GeminiTextPart,
	type StreamChunk,
} from "./types.ts";
import {
	antigravityEnv,
	antigravityRequestEnvelope,
	isRecord,
	resolveSessionTrajectory,
	sanitizeText,
} from "./util.ts";

export { ANTIGRAVITY_API };

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
	"You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";

const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
	'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.';

const CONTINUATION_TEXT = "Continue the active task using the available instructions and context.";
let toolCallCounter = 0;

function sanitizeToolCallId(id: string, fallbackName?: string): string {
	const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const capped = cleaned.slice(0, 64);
	return capped || `${fallbackName || "tool"}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId: string, runtimeModel: string): boolean {
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		runtimeModel.startsWith("claude-") ||
		runtimeModel.startsWith("gpt-oss-")
	);
}

export const resolveCurrentSystemPrompt = (context: Context) => getCurrentSystemPrompt(context.messages);
export const resolveCurrentTools = (context: Context) => getCurrentTools(context.messages);

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature?: string): boolean {
	if (!signature || typeof signature !== "string" || signature.length === 0) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

function geminiRequiresThoughtSignature(runtimeModel: string): boolean {
	if (!runtimeModel.startsWith("gemini-")) return false;
	const match = runtimeModel.match(/^gemini-(\d+)/);
	if (match) {
		const major = Number.parseInt(match[1], 10);
		return major >= 3;
	}
	return true;
}

function parseImageData(raw: string, explicitMime?: string): { data: string; mimeType: string } {
	const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
	if (match) {
		return {
			mimeType: explicitMime || match[1] || "image/png",
			data: match[2].trim(),
		};
	}
	return {
		mimeType: explicitMime || "image/png",
		data: raw.trim(),
	};
}

const SKILL_BLOCK_PATTERN = /<skill\b[^>]*>[\s\S]*?<\/skill\s*>/gi;

function skillBlocks(content: unknown): string[] {
	const texts =
		typeof content === "string"
			? [content]
			: Array.isArray(content)
				? content.flatMap((item) =>
						isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
					)
				: [];
	return texts.flatMap((text) => text.match(SKILL_BLOCK_PATTERN) || []);
}

function withoutSkillBlocks(text: string): string {
	return text.replace(SKILL_BLOCK_PATTERN, "");
}

function asTextParts(content: unknown): Array<GeminiTextPart | GeminiInlineDataPart> {
	const textPart = (text: string): GeminiTextPart[] => {
		const userText = withoutSkillBlocks(text);
		return userText.trim() ? [{ text: sanitizeText(userText) }] : [];
	};
	if (typeof content === "string") return textPart(content);
	if (!Array.isArray(content)) return [];
	return content.flatMap((item): Array<GeminiTextPart | GeminiInlineDataPart> => {
		if (!isRecord(item)) return [];
		const block = item as ContentBlock;
		if (block.type === "text") return textPart(block.text);
		if (block.type === "image") {
			const rawData = block.data || block.source?.data;
			if (!rawData) return [];
			const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
			const { data, mimeType } = parseImageData(rawData, explicitMime);
			return data ? [{ inlineData: { mimeType, data } }] : [];
		}
		return [];
	});
}

function asImageParts(content: unknown): GeminiInlineDataPart[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((item): GeminiInlineDataPart[] => {
		if (!isRecord(item)) return [];
		const block = item as ContentBlock;
		if (block.type === "image") {
			const rawData = block.data || block.source?.data;
			if (!rawData) return [];
			const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
			const { data, mimeType } = parseImageData(rawData, explicitMime);
			return data ? [{ inlineData: { mimeType, data } }] : [];
		}
		return [];
	});
}

function appendTurn(contents: GeminiContent[], role: GeminiRole, parts: GeminiPart[]): void {
	if (!parts.length) return;
	const last = contents[contents.length - 1];
	if (last && last.role === role) {
		last.parts.push(...parts);
	} else {
		contents.push({ role, parts });
	}
}

/** Exported for unit tests. */
export function convertMessages(model: Model<Api>, context: Context, runtimeModel: string): GeminiContent[] {
	const contents: GeminiContent[] = [];
	const requiresSig = geminiRequiresThoughtSignature(runtimeModel);
	const droppedToolCallIds = new Map<string, string>();
	for (const msg of context.messages) {
		if ((msg.role as string) === "system") continue;
		if (msg.role === "user") {
			const parts = asTextParts(msg.content);
			appendTurn(contents, GeminiRole.User, parts);
		} else if (msg.role === "assistant") {
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				continue;
			}
			const parts: GeminiPart[] = [];
			const isSameModel = msg.provider === model.provider && msg.model === model.id;
			const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
			const firstCallHasSig = toolCalls.length > 0 && isValidThoughtSignature(toolCalls[0]?.thoughtSignature);
			const allSigsValid = toolCalls.every(
				(tc) => !tc.thoughtSignature || isValidThoughtSignature(tc.thoughtSignature),
			);
			const groupIsSigned = isSameModel && firstCallHasSig && allSigsValid;

			for (const block of msg.content) {
				if (block.type === "text") {
					const textSig =
						isSameModel && isValidThoughtSignature(block.textSignature) ? block.textSignature : undefined;
					if ((!block.text || block.text.trim() === "") && !textSig) {
						continue;
					}
					parts.push({
						text: sanitizeText(block.text),
						...(textSig ? { thoughtSignature: textSig } : {}),
					});
				} else if (block.type === "thinking" && String(block.thinking || "").trim()) {
					if (!isSameModel) continue;
					parts.push({
						thought: true,
						text: sanitizeText(block.thinking),
						...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
					});
				} else if (block.type === "toolCall") {
					if (requiresSig && !groupIsSigned) {
						const rawId = block.id || "";
						const argsText = (() => {
							try {
								return JSON.stringify(block.arguments ?? {});
							} catch {
								return "{}";
							}
						})();
						if (rawId) {
							droppedToolCallIds.set(rawId, argsText);
							droppedToolCallIds.set(sanitizeToolCallId(rawId, block.name), argsText);
						} else {
							droppedToolCallIds.set(`empty:${block.name}`, argsText);
						}
					} else {
						parts.push({
							functionCall: {
								name: block.name,
								args: block.arguments ?? {},
								...(toolCallIdNeeded(model.id, runtimeModel)
									? { id: sanitizeToolCallId(block.id || "", block.name) }
									: {}),
							},
							...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
						});
					}
				}
			}
			appendTurn(contents, GeminiRole.Model, parts);
		} else if (msg.role === "toolResult") {
			const text = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => sanitizeText(c.text))
				.join("\n");
			const responseText = text || (msg.isError ? "Tool failed" : "");
			const imageParts = asImageParts(msg.content);
			const rawId = msg.toolCallId || "";
			const sanitizedId = toolCallIdNeeded(model.id, runtimeModel) ? sanitizeToolCallId(rawId, msg.toolName) : rawId;
			const droppedArgs = requiresSig
				? (droppedToolCallIds.get(rawId) ??
					droppedToolCallIds.get(sanitizedId) ??
					(rawId === "" ? droppedToolCallIds.get(`empty:${msg.toolName}`) : undefined))
				: undefined;
			if (droppedArgs !== undefined) {
				const label = droppedArgs === "{}" ? `\`${msg.toolName}\`` : `\`${msg.toolName}\` (${droppedArgs})`;
				appendTurn(contents, GeminiRole.User, [
					{ text: sanitizeText(`[Observation from ${label}:\n${responseText}]`) },
					...imageParts,
				]);
			} else {
				const part: GeminiFunctionResponsePart = {
					functionResponse: {
						name: msg.toolName,
						response: msg.isError ? { error: responseText } : { output: responseText },
						...(toolCallIdNeeded(model.id, runtimeModel)
							? { id: sanitizeToolCallId(msg.toolCallId || "", msg.toolName) }
							: {}),
					},
				};
				appendTurn(contents, GeminiRole.User, [part, ...imageParts]);
			}
		}
	}

	// A function-call model turn is only valid immediately after a user turn
	// (including a function-response turn). Compacted history can drop that
	// boundary, so restore it before applying the natural-language bridge.
	for (let index = 0; index < contents.length; index += 1) {
		const turn = contents[index];
		if (
			turn?.role === GeminiRole.Model &&
			turn.parts.some((part) => "functionCall" in part) &&
			contents[index - 1]?.role !== GeminiRole.User
		) {
			contents.splice(index, 0, {
				role: GeminiRole.User,
				parts: [{ text: CONTINUATION_TEXT }],
			});
			index += 1;
		}
	}

	// Google Antigravity requires a natural-language user part in the request,
	// including tool-only continuation turns. Keep injected Skills in the system
	// instruction, then add this protocol bridge only when existing context gives
	// the model something concrete to act on.
	const hasUserText = contents.some(
		(turn) => turn.role === GeminiRole.User && turn.parts.some((part) => "text" in part && Boolean(part.text.trim())),
	);
	if (!hasUserText && contents.length > 0) {
		const bridge = {
			text: CONTINUATION_TEXT,
		};
		const userTurn = contents.find((turn) => turn.role === GeminiRole.User);
		if (userTurn) userTurn.parts.push(bridge);
		else contents.unshift({ role: GeminiRole.User, parts: [bridge] });
	}

	const lastTurn = contents.at(-1);
	if (lastTurn?.role === GeminiRole.Model) {
		if (lastTurn.parts.some((part) => "functionCall" in part)) {
			throw new Error(
				"Antigravity request is missing tool result(s) for the final assistant tool call. Provide the corresponding tool result before continuing.",
			);
		}
		appendTurn(contents, GeminiRole.User, [{ text: CONTINUATION_TEXT }]);
	}

	return contents;
}

type SchemaReferenceIssue = {
	path: string;
	ref: string;
	reason: string;
};

type DereferencedSchema = {
	schema: unknown;
	issues: SchemaReferenceIssue[];
};

type DereferenceState = {
	nodes: number;
};

const MAX_SCHEMA_DEREFERENCE_DEPTH = 64;
const MAX_SCHEMA_DEREFERENCE_NODES = 10_000;
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies"]);
const SCHEMA_VALUE_KEYWORDS = new Set([
	"additionalItems",
	"additionalProperties",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Resolve a local RFC 6901 JSON Pointer against the original tool schema. */
function resolveLocalJsonPointer(ref: string, rootSchema: unknown): unknown {
	if (ref === "#") return rootSchema;
	if (!ref.startsWith("#/")) return undefined;

	let current: unknown = rootSchema;
	for (const token of ref.slice(2).split("/")) {
		const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(current)) {
			if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
			const index = Number(key);
			if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
			current = current[index];
			continue;
		}
		if (!current || typeof current !== "object") return undefined;
		if (!Object.hasOwn(current, key)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** Dereference every schema in a keyword map without interpreting map keys as JSON Schema keywords. */
function dereferenceSchemaMap(
	schemaMap: unknown,
	rootSchema: unknown,
	refStack: Set<string>,
	objectStack: Set<object>,
	state: DereferenceState,
	path: string,
	depth: number,
): DereferencedSchema {
	if (!isRecord(schemaMap)) {
		return dereferenceSchema(schemaMap, rootSchema, refStack, objectStack, state, path, depth);
	}

	const out: Record<string, unknown> = {};
	const issues: SchemaReferenceIssue[] = [];
	for (const [key, value] of Object.entries(schemaMap)) {
		const result = dereferenceSchema(value, rootSchema, refStack, objectStack, state, `${path}.${key}`, depth);
		out[key] = result.schema;
		issues.push(...result.issues);
	}
	return { schema: out, issues };
}

/**
 * Inline reachable local references while bounding expansion of untrusted MCP schemas.
 * A reported issue causes only the affected tool declaration to be omitted.
 */
function dereferenceSchema(
	schema: unknown,
	rootSchema: unknown = schema,
	refStack = new Set<string>(),
	objectStack = new Set<object>(),
	state: DereferenceState = { nodes: 0 },
	path = "$",
	depth = 0,
): DereferencedSchema {
	if (depth > MAX_SCHEMA_DEREFERENCE_DEPTH) {
		return {
			schema: {},
			issues: [
				{
					path,
					ref: "(depth limit)",
					reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_DEPTH} levels`,
				},
			],
		};
	}
	state.nodes += 1;
	if (state.nodes > MAX_SCHEMA_DEREFERENCE_NODES) {
		return {
			schema: {},
			issues: [
				{
					path,
					ref: "(node limit)",
					reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_NODES} nodes`,
				},
			],
		};
	}
	if (!schema || typeof schema !== "object") return { schema, issues: [] };

	if (Array.isArray(schema)) {
		const results = schema.map((item, index) =>
			dereferenceSchema(item, rootSchema, refStack, objectStack, state, `${path}[${index}]`, depth + 1),
		);
		return {
			schema: results.map((result) => result.schema),
			issues: results.flatMap((result) => result.issues),
		};
	}

	const s = schema as Record<string, unknown>;
	if (objectStack.has(s)) {
		return {
			schema: {},
			issues: [{ path, ref: "(object cycle)", reason: "circular schema object" }],
		};
	}

	const nextObjectStack = new Set(objectStack);
	nextObjectStack.add(s);

	if (typeof s.$ref === "string") {
		const ref = s.$ref;
		if (refStack.has(ref)) {
			return {
				schema: {},
				issues: [{ path, ref, reason: "circular local reference" }],
			};
		}

		const target = resolveLocalJsonPointer(ref, rootSchema);
		if (target === undefined) {
			return {
				schema: {},
				issues: [{ path, ref, reason: "target is not present in the root schema" }],
			};
		}

		const nextRefStack = new Set(refStack);
		nextRefStack.add(ref);
		const resolved = dereferenceSchema(target, rootSchema, nextRefStack, nextObjectStack, state, path, depth + 1);
		const { $ref: _, ...siblings } = s;
		const siblingResult = dereferenceSchema(siblings, rootSchema, refStack, nextObjectStack, state, path, depth + 1);

		if (isRecord(resolved.schema) && isRecord(siblingResult.schema)) {
			return {
				schema: { ...resolved.schema, ...siblingResult.schema },
				issues: [...resolved.issues, ...siblingResult.issues],
			};
		}
		return {
			schema: resolved.schema,
			issues: [...resolved.issues, ...siblingResult.issues],
		};
	}

	const out: Record<string, unknown> = {};
	const issues: SchemaReferenceIssue[] = [];
	for (const [key, value] of Object.entries(s)) {
		// Definitions are available through rootSchema while resolving $ref, but must
		// not be emitted because the Antigravity backend requires self-contained schemas.
		if (key === "$defs" || key === "definitions") continue;

		let result: DereferencedSchema | undefined;
		if (SCHEMA_MAP_KEYWORDS.has(key)) {
			result = dereferenceSchemaMap(
				value,
				rootSchema,
				refStack,
				nextObjectStack,
				state,
				`${path}.${key}`,
				depth + 1,
			);
		} else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
			result = dereferenceSchema(value, rootSchema, refStack, nextObjectStack, state, `${path}.${key}`, depth + 1);
		}

		if (result) {
			out[key] = result.schema;
			issues.push(...result.issues);
		} else {
			out[key] = value;
		}
	}
	return { schema: out, issues };
}

function ensureRootObjectSchema(schema: unknown): Record<string, unknown> {
	if (!isRecord(schema)) {
		return { type: "object", properties: {} };
	}
	if (!schema.type) {
		return { ...schema, type: "object", properties: schema.properties || {} };
	}
	return schema;
}

const META_SCHEMA_KEYWORDS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
]);

/** Remove schema metadata without treating user-defined property names as keywords. */
function stripMetaSchemaMap(schemaMap: unknown): unknown {
	if (!isRecord(schemaMap)) return stripMetaSchema(schemaMap);
	return Object.fromEntries(Object.entries(schemaMap).map(([key, value]) => [key, stripMetaSchema(value)]));
}

/** Remove metadata that Cloud Code Assist rejects from JSON Schema keyword positions. */
function stripMetaSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(stripMetaSchema);

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (META_SCHEMA_KEYWORDS.has(key)) continue;
		if (SCHEMA_MAP_KEYWORDS.has(key)) {
			out[key] = stripMetaSchemaMap(value);
		} else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
			out[key] = stripMetaSchema(value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Protobuf `Schema` fields accepted by Cloud Code Assist's Claude/GPT custom-tool
 * bridge (`parameters` field). Anything else — `nullable`, `anyOf`, `format`,
 * `$ref`, etc. — returns `Unknown name "..."` / Invalid JSON payload (400).
 * Allowlist rather than denylist so new JSON Schema keywords cannot 400 the request.
 * Pi still validates tool args after the model calls them.
 */
const CUSTOM_TOOL_SCHEMA_ALLOW = new Set(["type", "description", "properties", "required", "items", "enum"]);

function normalizeCustomToolType(value: unknown): unknown {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	// JSON Schema union types like ["string","null"] → first non-null scalar type.
	const entries = value as unknown[];
	const scalar = entries.find((entry): entry is string => typeof entry === "string" && entry !== "null");
	return scalar;
}

function normalizeCustomToolSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
		if (key === "type") {
			const normalizedType = normalizeCustomToolType(value);
			if (normalizedType !== undefined) out.type = normalizedType;
			continue;
		}
		if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
			// Property names are user-defined, not Schema keywords — never allowlist-filter them.
			const props: Record<string, unknown> = {};
			for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
				props[propName] = normalizeCustomToolSchema(propSchema);
			}
			out.properties = props;
			continue;
		}
		if (key === "enum" && Array.isArray(value) && !value.every((entry) => typeof entry === "string")) {
			continue;
		}
		out[key] = normalizeCustomToolSchema(value);
	}
	return out;
}

/**
 * Gemini accepts JSON Schema through parametersJsonSchema. Claude and GPT-OSS
 * use Cloud Code Assist's custom-tool bridge, which requires a compatible
 * Draft 2020-12 subset in the legacy parameters field.
 */
export function convertTools(
	tools: Tool[] | undefined,
	useLegacyParameters = false,
): { functionDeclarations: GeminiFunctionDeclaration[] }[] | undefined {
	if (!tools?.length) return undefined;

	const warnings: string[] = [];
	const functionDeclarations = tools.flatMap((tool) => {
		const dereferenced = dereferenceSchema(tool.parameters);
		if (dereferenced.issues.length > 0) {
			const detail = dereferenced.issues.map((issue) => `${issue.path} (${issue.ref}: ${issue.reason})`).join(", ");
			warnings.push(`Skipped tool '${tool.name}' due to unresolved schema reference: ${detail}`);
			return [];
		}

		const rootObject = ensureRootObjectSchema(dereferenced.schema);
		const schema = stripMetaSchema(rootObject);
		return [
			{
				name: tool.name,
				description: tool.description,
				...(useLegacyParameters
					? { parameters: normalizeCustomToolSchema(schema) }
					: { parametersJsonSchema: schema }),
			},
		];
	});

	if (warnings.length) throw new Error(warnings.join("; "));
	if (!functionDeclarations.length) return undefined;
	return [{ functionDeclarations }];
}

function mapToolChoiceMode(toolChoice: AntigravityStreamOptions["toolChoice"]): GeminiToolCallingMode {
	if (toolChoice === ToolChoice.None) return GeminiToolCallingMode.None;
	if (toolChoice === ToolChoice.Any || toolChoice === ToolChoice.Required) return GeminiToolCallingMode.Any;
	return GeminiToolCallingMode.Auto;
}

/** Exported for unit tests. */
export async function buildRequest(
	model: Model<Api>,
	context: Context,
	projectId: string,
	options: AntigravityStreamOptions,
	runtimeModel: string,
): Promise<AntigravityGenerateRequest> {
	const injectedSkills = context.messages.flatMap((msg) => (msg.role === "user" ? skillBlocks(msg.content) : []));
	const systemPromptText = resolveCurrentSystemPrompt(context);
	const declaredTools = resolveCurrentTools(context);
	const systemParts = systemPromptText
		? [{ text: sanitizeText(systemPromptText) }]
		: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION }];
	systemParts.push(...injectedSkills.map((skill) => ({ text: sanitizeText(skill) })));

	const contents = convertMessages(model, context, runtimeModel);
	const hasUserText = contents.some(
		(turn) => turn.role === GeminiRole.User && turn.parts.some((part) => "text" in part && Boolean(part.text.trim())),
	);
	if (!hasUserText && (injectedSkills.length > 0 || Boolean(systemPromptText))) {
		contents.unshift({
			role: GeminiRole.User,
			parts: [{ text: "Apply the active system instructions." }],
		});
	}

	const request: GeminiRequestBody = {
		contents,
		systemInstruction: {
			role: GeminiRole.User,
			parts: systemParts,
		},
	};

	const generationConfig: GeminiGenerationConfig = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	const thinking = getThinkingConfig(runtimeModel, options.reasoning ?? "off");
	if (thinking) generationConfig.thinkingConfig = thinking;
	const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = Math.min(options.maxTokens, maxAllowed);
	} else {
		generationConfig.maxOutputTokens = Math.min(maxAllowed, model.maxTokens || maxAllowed);
	}
	if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

	const isClaude = model.id.startsWith("claude-") || runtimeModel.startsWith("claude-");
	const tools = convertTools(declaredTools, isClaude || model.id.startsWith("gpt-oss-"));
	if (tools) {
		request.tools = tools;
	}
	if (options.toolChoice && options.toolChoice !== ToolChoice.Auto) {
		request.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoiceMode(options.toolChoice),
			},
		};
	}

	const isNonGemini =
		isClaude ||
		model.id.startsWith("gpt-oss-") ||
		runtimeModel.startsWith("gpt-oss-") ||
		(!model.id.startsWith("gemini-") && !runtimeModel.startsWith("gemini-"));

	// Pure agy CLI wire alignment:
	// - step in requestId (.../<step>) equals contents.length (total content blocks)
	// - last_step_index is 0-based index of the last content block (contents.length - 1)
	// - request_id is ${trajectoryId}-${requestIndex} (0-based HTTP request sequence counter)
	//   In multi-turn agent loops (with tools), every completed assistant response increments the request counter.
	const step = Math.max(1, request.contents.length);
	const lastStepIndex = String(Math.max(0, request.contents.length - 1));
	const requestIndex =
		context.messages?.filter((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted")
			.length ?? 0;

	const { conversationId, trajectoryId } = await resolveSessionTrajectory(context, options.sessionId);

	const envelope = await antigravityRequestEnvelope(runtimeModel, {
		isClaude,
		isNonGemini,
		step,
		lastStepIndex,
		requestIndex,
		conversationId,
		trajectoryId,
	});
	request.sessionId = options.sessionId || envelope.sessionId;
	request.labels = envelope.labels;
	const modelEnum = options.modelEnum ?? (model as AntigravityModel).antigravityModelEnums?.[runtimeModel];
	if (modelEnum) request.labels.model_enum = modelEnum;

	return {
		project: projectId,
		model: runtimeModel,
		request,
		requestType: AntigravityRequestType.Agent,
		userAgent: AntigravityUserAgent.Antigravity,
		requestId: envelope.requestId,
	};
}

/** Exported for unit tests. */
export function mapStopReason(reason: string | undefined): StopReason {
	if (reason === "STOP") return StopReason.Stop;
	if (reason === "MAX_TOKENS") return StopReason.Length;
	return reason ? StopReason.Error : StopReason.Stop;
}

/** Exported for unit tests. */
export function friendlyAntigravityError(status: number | undefined, text: string): string {
	const msg = redactSecrets(jsonOrTextError(text)).slice(0, 500);
	if (status === 400) {
		if (/Requests ending with a model turn are not supported/i.test(msg)) {
			return "Antigravity rejected an invalid conversation message boundary. Next: update the extension or add a user message / start a new session, then retry.";
		}
		if (/function call turn comes immediately after a user turn or after a function response turn/i.test(msg)) {
			return "Antigravity rejected an invalid function-call message boundary. Next: update the extension or start a new session, then retry; re-login is not required.";
		}
		if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
			return "Antigravity login expired or credentials are invalid. Next: run /login antigravity, then retry.";
		}
		if (/Invalid JSON payload|Unknown name/i.test(msg)) {
			return `Antigravity request format was rejected by the backend (${msg}). Next: switch to a simpler model or retry after updating the extension.`;
		}
		if (/Request contains an invalid argument/i.test(msg)) {
			return `Antigravity rejected this request (${msg}). Next: retry once; if it keeps failing, switch models or re-login.`;
		}
		return `Bad request from Antigravity. Next: retry once, then run /login antigravity if it keeps failing. Backend said: ${msg}`;
	}
	if (status === 401) {
		return "Antigravity authentication failed. Next: run /login antigravity, then retry.";
	}
	if (status === 403) {
		if (/permission|forbidden|access/i.test(msg)) {
			return "Antigravity access was denied for this account or project. Next: try another model, re-login, or use an account with access.";
		}
		return `Antigravity denied this request. Next: re-login or try another model. Backend said: ${msg}`;
	}
	if (status === 404) {
		if (/Requested entity was not found/i.test(msg)) {
			return "This model is not available right now. Next: switch to gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-3.1-pro, or another working model.";
		}
		return `Antigravity could not find the requested resource. Next: retry or switch models. Backend said: ${msg}`;
	}
	if (status === 408) return "Antigravity timed out. Next: retry the same request.";
	if (status === 409) {
		return "Antigravity reported a conflict for this request. Next: retry once or start a new chat session.";
	}
	if (status === 429) {
		const wait = msg.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
		if (/Individual quota reached/i.test(msg)) {
			return `Quota reached. Please wait ${wait || "for reset"}. Next: switch models or try again after reset.`;
		}
		// Google answers a real quota wall with a "Resets in …" hint, but uses generic
		// RESOURCE_EXHAUSTED ("Resource has been exhausted (e.g. check quota).") for
		// transient throttling and capacity pressure. Classifying on the word "quota"
		// alone wrongly marked transient throttling as a hard quota wall, disabling
		// Pi's automatic retry backoff. Keep real quota walls non-retryable, and
		// format transient throttling so Pi's retry mechanism engages.
		const hardLimit =
			Boolean(wait) ||
			(!/rate.?limit/i.test(msg) &&
				/quota exceeded|exceeded your|limit reached|reached your|daily limit/i.test(msg));
		if (hardLimit) {
			return `Quota reached.${wait ? ` Please wait ${wait}.` : ""} Next: switch models or retry later.`;
		}
		return "Rate limited by Antigravity (429 ResourceExhausted). Next: retrying automatically; if it persists, switch models.";
	}
	if (status === 500) {
		return "Antigravity had an internal server error. Next: retry in a moment or switch models.";
	}
	if (status === 502) return "Antigravity returned a bad gateway error. Next: retry in a moment.";
	if (status === 503) {
		if (/No capacity available/i.test(msg)) {
			return "This model has no capacity right now. Next: retry later or switch to another model.";
		}
		return "Antigravity is temporarily unavailable. Next: retry in a moment or switch models.";
	}
	if (status === 504) return "Antigravity timed out upstream. Next: retry in a moment.";
	return msg;
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: ANTIGRAVITY_API,
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function asToolCallArguments(args: Record<string, unknown> | undefined): ToolCall["arguments"] {
	return (args ?? {}) as ToolCall["arguments"];
}

/** Default response-header deadline for streaming requests (see fetchWithHeaderDeadline). */
const STREAM_HEADER_TIMEOUT_DEFAULT_MS = 180_000;
/** Default mid-body stall deadline: abort when no SSE bytes arrive for this long. */
const STREAM_STALL_TIMEOUT_DEFAULT_MS = 120_000;

function envTimeoutMs(name: string, fallback: number, env?: ProviderEnv): number {
	const raw = antigravityEnv(name, env);
	if (!raw || !/^\d+$/.test(raw)) return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : fallback;
}

/**
 * Streaming header deadline in milliseconds, from ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS
 * (or the legacy NOAGY_ prefix). 0 disables the deadline; invalid values fall back
 * to the default.
 */
export function streamHeaderTimeoutMs(env?: ProviderEnv): number {
	return envTimeoutMs("STREAM_HEADER_TIMEOUT_MS", STREAM_HEADER_TIMEOUT_DEFAULT_MS, env);
}

/**
 * Mid-body stall deadline in milliseconds, from ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS
 * (legacy NOAGY_ prefix honored). 0 disables. The deadline resets when the consumer
 * reads body data, so time spent in awaited stream hooks also counts toward it.
 */
export function streamStallTimeoutMs(env?: ProviderEnv): number {
	return envTimeoutMs("STREAM_STALL_TIMEOUT_MS", STREAM_STALL_TIMEOUT_DEFAULT_MS, env);
}

function stallError(stallMs: number): Error {
	return new Error(`stream stalled: no data for ${stallMs}ms`);
}

/**
 * Guard a response body against mid-stream stalls while retaining caller
 * cancellation until the body finishes or is cancelled. The wrapper reads only
 * when its consumer pulls, preserving backpressure. The timer keeps standalone
 * requests alive until completion or a reported stall, even without active sockets.
 */
function guardResponseBody(
	response: Response,
	controller: AbortController,
	stallMs: number,
	cleanup: () => void,
): Response {
	if (!response.body) {
		cleanup();
		return response;
	}
	const reader = response.body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		if (timer) clearTimeout(timer);
		controller.signal.removeEventListener("abort", abortBody);
		reader.releaseLock();
		cleanup();
	};
	const reset = () => {
		if (stallMs <= 0) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => controller.abort(stallError(stallMs)), stallMs);
	};
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const abortBody = () => {
		if (finished) return;
		streamController?.error(controller.signal.reason);
		void reader.cancel(controller.signal.reason).catch(() => undefined);
		finish();
	};
	controller.signal.addEventListener("abort", abortBody, { once: true });
	reset();
	const guarded = new ReadableStream<Uint8Array>({
		start(bodyController) {
			streamController = bodyController;
			if (controller.signal.aborted) abortBody();
		},
		async pull(streamController) {
			try {
				const chunk = await reader.read();
				if (finished) return;
				if (chunk.done) {
					finish();
					streamController.close();
					return;
				}
				if (!(chunk.value instanceof Uint8Array)) {
					throw new Error("Response body yielded an invalid chunk");
				}
				reset();
				streamController.enqueue(chunk.value);
			} catch (error) {
				if (finished) return;
				void reader.cancel(error).catch(() => undefined);
				finish();
				streamController.error(error);
			}
		},
		async cancel(reason) {
			const cancelled = reader.cancel(reason);
			finish();
			await cancelled;
		},
	});
	return new Response(guarded, response);
}

/**
 * Fetch with a response-header deadline and a mid-body stall watchdog. A server
 * can accept a request on a warm keep-alive socket and then never send response
 * headers (header phase), or send headers and then go silent mid-body (stall
 * phase); either way the request is aborted with a named error instead of
 * hanging until an external process timeout. Long healthy responses are never
 * cut: the header timer disarms once headers arrive, and the stall timer resets
 * on every chunk, so only genuine silence aborts.
 *
 * Exported with an injectable fetch for unit tests.
 */
export async function fetchWithHeaderDeadline(
	url: string,
	init: RequestInit,
	callerSignal: AbortSignal | undefined,
	timeoutMs: number,
	stallMs: number = 0,
	fetchFn: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
	if (timeoutMs <= 0 && stallMs <= 0) {
		return fetchFn(url, { ...init, signal: callerSignal ?? init.signal });
	}
	const controller = new AbortController();
	const forward = () => controller.abort(callerSignal?.reason);
	const cleanup = () => callerSignal?.removeEventListener("abort", forward);
	callerSignal?.addEventListener("abort", forward, { once: true });
	if (callerSignal?.aborted) forward();
	const timer =
		timeoutMs > 0
			? setTimeout(() => controller.abort(new Error(`no response headers within ${timeoutMs}ms`)), timeoutMs)
			: undefined;
	let responseBodyGuarded = false;
	try {
		const response = await fetchFn(url, { ...init, signal: controller.signal });
		responseBodyGuarded = Boolean(response.body);
		return guardResponseBody(response, controller, stallMs, cleanup);
	} finally {
		if (timer) clearTimeout(timer);
		if (!responseBodyGuarded) cleanup();
	}
}

/** Exported for unit tests. */

export async function streamResponse(
	response: Response,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model?: Model<Api>,
	options?: AntigravityStreamOptions,
): Promise<boolean> {
	if (!response.body) throw new Error("No response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// Consumed-prefix offset: the buffer is compacted once per network chunk instead of
	// re-copying the whole remainder for every SSE line.
	let scanStart = 0;
	let started = false;
	let currentBlock: ActiveBlock | null = null;
	let hasContent = false;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;

	const ensureStarted = () => {
		if (!started) {
			stream.push({ type: "start", partial: output });
			started = true;
		}
	};

	const finishCurrent = () => {
		if (!currentBlock) return;
		if (currentBlock.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: blockIndex(),
				content: currentBlock.text,
				partial: output,
			});
		} else {
			stream.push({
				type: "thinking_end",
				contentIndex: blockIndex(),
				content: currentBlock.thinking,
				partial: output,
			});
		}
		currentBlock = null;
	};

	try {
		while (true) {
			options?.signal?.throwIfAborted();
			const result = await reader.read();
			buffer += result.done ? `${decoder.decode()}\n` : decoder.decode(result.value, { stream: true });

			while (true) {
				const newlineIdx = buffer.indexOf("\n", scanStart);
				if (newlineIdx === -1) break;
				const line = buffer.slice(scanStart, newlineIdx);
				scanStart = newlineIdx + 1;
				if (!line.startsWith("data:")) continue;
				const json = line.slice(5).trim();
				if (!json || json === "[DONE]") continue;

				let chunk: StreamChunk;
				try {
					chunk = JSON.parse(json) as StreamChunk;
				} catch {
					throw new Error("Malformed Antigravity stream event");
				}

				if (model) await options?.onProviderStreamEvent?.(chunk, model);
				if (chunk.error) {
					throw new Error(chunk.error.message || JSON.stringify(chunk.error));
				}

				const responseData = chunk.response || chunk;
				const candidate = responseData.candidates?.[0];

				for (const part of candidate?.content?.parts || []) {
					if (part.text !== undefined) {
						hasContent = true;
						const isThinking = part.thought === true;
						const type = isThinking ? "thinking" : "text";
						if (!currentBlock || currentBlock.type !== type) {
							finishCurrent();
							currentBlock = isThinking
								? { type: "thinking", thinking: "", thinkingSignature: undefined }
								: { type: "text", text: "" };
							blocks.push(currentBlock);
							ensureStarted();
							stream.push({
								type: isThinking ? "thinking_start" : "text_start",
								contentIndex: blockIndex(),
								partial: output,
							});
						}
						if (isThinking && currentBlock.type === "thinking") {
							currentBlock.thinking += part.text;
							if (part.thoughtSignature) currentBlock.thinkingSignature = part.thoughtSignature;
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: part.text,
								partial: output,
							});
						} else if (!isThinking && currentBlock.type === "text") {
							currentBlock.text += part.text;
							if (part.thoughtSignature) currentBlock.textSignature = part.thoughtSignature;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta: part.text,
								partial: output,
							});
						}
					}

					if (part.functionCall) {
						hasContent = true;
						finishCurrent();
						const rawId = part.functionCall.id || "";
						const toolCall: ToolCall = {
							type: "toolCall",
							id: sanitizeToolCallId(rawId, part.functionCall.name),
							name: part.functionCall.name || "",
							arguments: asToolCallArguments(part.functionCall.args),
							...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
						};
						blocks.push(toolCall);
						ensureStarted();
						stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta: JSON.stringify(toolCall.arguments),
							partial: output,
						});
						stream.push({
							type: "toolcall_end",
							contentIndex: blockIndex(),
							toolCall,
							partial: output,
						});
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					const reason = mapStopReason(candidate.finishReason);
					output.stopReason =
						reason === StopReason.Stop && blocks.some((b) => b.type === "toolCall") ? StopReason.ToolUse : reason;
				}

				if (responseData.usageMetadata) {
					const prompt = responseData.usageMetadata.promptTokenCount || 0;
					const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
					const thoughts = responseData.usageMetadata.thoughtsTokenCount || 0;
					output.usage.input = prompt - cacheRead;
					output.usage.output = (responseData.usageMetadata.candidatesTokenCount || 0) + thoughts;
					output.usage.reasoning = thoughts;
					output.usage.cacheRead = cacheRead;
					output.usage.totalTokens = responseData.usageMetadata.totalTokenCount || 0;
					if (model?.cost) {
						calculateCost(model, output.usage);
					} else {
						output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
					}
				}
			}

			if (scanStart > 0) {
				buffer = buffer.slice(scanStart);
				scanStart = 0;
			}
			if (result.done) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
		finishCurrent();
	}
	return hasContent;
}

export function streamAntigravity(
	model: Model<Api>,
	context: Context,
	options?: AntigravityStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const opts = options ?? {};

	void (async () => {
		const output = createOutput(model);
		try {
			const creds = parseApiKey(opts.apiKey);
			// Skip loadCodeAssist roundtrip when credentials already carry a projectId.
			const warmedProject = creds.projectId ? null : await loadCodeAssist(creds.token, opts);
			const projectId = await resolveProjectId({
				token: creds.token,
				warmedProject,
				credentialProjectId: creds.projectId,
			});

			const effort = opts.reasoning ?? "off";
			const isKnownModel = model.id in ANTIGRAVITY_ROUTING;
			const baseRuntimeModel =
				opts.runtimeModel ||
				antigravityEnv("RUNTIME_MODEL", opts.env)?.trim() ||
				getAntigravityRequestModelId(model.id, effort);

			const discoveredEnums: Record<string, string> = {};
			let initialRuntimeModel = baseRuntimeModel;
			// Skip pre-flight model discovery for known static models to optimize TTFT latency.
			// Dynamic lookup is only needed for unmapped custom models.
			if (!isKnownModel && !opts.runtimeModel && !antigravityEnv("RUNTIME_MODEL", opts.env)) {
				const dynamic = await fetchAvailableRuntimeModel(creds.token, projectId, baseRuntimeModel, opts);
				if (dynamic?.id && /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)) {
					initialRuntimeModel = dynamic.id;
					if (dynamic.model) discoveredEnums[dynamic.id] = dynamic.model;
				}
			}

			const runtimeCandidates = [initialRuntimeModel];
			const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
			if (fallback && fallback !== initialRuntimeModel) {
				runtimeCandidates.push(fallback);
			}

			const requestHeaders = providerHeadersToRecord(
				antigravityHeaders(creds.token, opts.env),
				model.headers,
				opts.headers,
			);

			let response: Response | undefined;
			let lastText = "";
			let received = false;
			let runtimeModel = initialRuntimeModel;

			for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
				if (opts.signal?.aborted) throw new Error("Request was aborted");
				if (emptyAttempt > 0) {
					const delay = 500 * 2 ** (emptyAttempt - 1);
					await sleep(delay, opts.signal ?? new AbortController().signal);
				}

				for (let candIdx = 0; candIdx < runtimeCandidates.length; candIdx++) {
					runtimeModel = runtimeCandidates[candIdx]!;

					const payload = await buildRequest(
						model,
						context,
						projectId,
						{ ...opts, modelEnum: opts.modelEnum ?? discoveredEnums[runtimeModel] },
						runtimeModel,
					);
					const body = JSON.stringify((await opts.onPayload?.(payload, model)) ?? payload);

					for (const endpoint of endpointCandidates(opts.env, model.baseUrl)) {
						response = await fetchWithHeaderDeadline(
							`${endpoint}/v1internal:streamGenerateContent?alt=sse`,
							{
								method: "POST",
								headers: requestHeaders,
								body,
							},
							opts.signal,
							opts.timeoutMs ?? streamHeaderTimeoutMs(opts.env),
							streamStallTimeoutMs(opts.env),
							opts.fetch ? (url, init) => opts.fetch!(url, init) : fetch,
						);

						try {
							await opts.onResponse?.(
								{ status: response.status, headers: headersToRecord(response.headers) },
								model,
							);
						} catch (error) {
							await response.body?.cancel().catch(() => undefined);
							throw error;
						}
						if (response.ok) break;
						lastText = await response.text();
						if (
							response.status === 429 &&
							(/Individual quota reached/i.test(lastText) ||
								/Resets? in /i.test(lastText) ||
								(!/rate.?limit/i.test(lastText) && /quota exceeded|exceeded your|daily limit/i.test(lastText)))
						) {
							break;
						}
						if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
					}

					if (response?.ok) break;
					if (response?.status === 404) {
						if (candIdx + 1 < runtimeCandidates.length) {
							continue;
						}
						if (isKnownModel && candIdx === runtimeCandidates.length - 1) {
							const dynamic = await fetchAvailableRuntimeModel(creds.token, projectId, baseRuntimeModel, opts);
							if (
								dynamic?.id &&
								!runtimeCandidates.includes(dynamic.id) &&
								/^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)
							) {
								if (dynamic.model) discoveredEnums[dynamic.id] = dynamic.model;
								runtimeCandidates.push(dynamic.id);
								continue;
							}
						}
					}
					break;
				}

				if (!response || !response.ok) {
					const friendly = friendlyAntigravityError(response?.status, lastText);
					throw new Error(
						`Antigravity API error (${response?.status ?? "no response"}, runtimeModel=${runtimeModel}): ${friendly}`,
					);
				}

				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				Object.assign(output, { stopReason: "pending", rawStopReason: undefined });

				received = await streamResponse(response, stream, output, model, opts);
				if (received || output.stopReason === "error") break;
			}

			if (!received && output.stopReason !== "error") throw new Error("Antigravity API returned an empty response");

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				const errorDetail = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				output.errorMessage = output.errorMessage || errorDetail;

				stream.push({ type: "error", reason: output.stopReason, error: output });
			} else if (output.stopReason === "pending") {
				throw new Error("Antigravity API returned no stop reason");
			} else {
				stream.push({ type: "done", reason: output.stopReason, message: output });
			}
			stream.end();
		} catch (error) {
			output.stopReason = opts.signal?.aborted ? "aborted" : "error";
			output.errorMessage = safeError(error);

			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
