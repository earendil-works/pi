import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type {
	BetaInputTransformation,
	BetaStopReason,
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
	BetaRawMessageStreamEvent as RawMessageStreamEvent,
	BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import {
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
import { calculateCost } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ImageContent,
	Message,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { parseJsonWithRepair } from "../utils/json-parse.ts";
import {
	applyOpenRouterReportedCost,
	isOpenRouterModel,
	type OpenRouterUsageAccounting,
} from "../utils/openrouter-cost.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	getCurrentTools,
	getInitialSystemMessage,
	resolveTranscript,
	type TranscriptContext,
} from "../utils/transcript.ts";

import {
	getJsonSchemaToolParameters,
	isStrictToolLimitErrorMessage,
	prefersJsonSchemaStrictSampling,
	resolveJsonSchemaStrictSampling,
	type UnsupportedStrictSchemaKeywordCheck,
} from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";
import { splitErrorToolResultImages, transformMessages } from "./transform-messages.ts";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.280";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

function convertImageBlock(image: ImageContent) {
	return {
		type: "image" as const,
		source: {
			type: "base64" as const,
			media_type: image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
			data: image.data,
		},
	};
}

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return convertImageBlock(block);
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";
const MESSAGE_THREADS_BETA = "message-threads-2026-08-12";

/**
 * Stable deferred tool declared whenever native tool changes are in use. Anthropic adds
 * hidden prompt scaffolding for mid-conversation tool changes; declaring this placeholder
 * from the first request keeps that scaffolding in the cached prefix, so the first tool
 * change does not invalidate the cache (measured: full miss without it). It is never
 * activated and the model cannot see it.
 */
const DEFERRED_TOOL_PLACEHOLDER: BetaTool = {
	name: "__pi_deferred_placeholder__",
	description: "Reserved placeholder. Never available. Never call this.",
	input_schema: { type: "object", properties: {}, required: [] },
	defer_loading: true,
};

function shouldUseServerSideFallbackBeta(model: Model<"anthropic-messages">): boolean {
	return (model.compat?.allowedFallbackModels?.length ?? 0) > 0;
}

function getAnthropicCompat(model: Model<"anthropic-messages">) {
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? isOpenRouter,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (isOpenRouter ? "openrouter" : undefined),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
		// Gateways that drop unknown request fields would silently turn a `continue` into a request
		// without the earlier conversation, so the default is limited to Anthropic's own endpoint.
		// Widen or remove this restriction once proxies generally forward the `thread` field.
		supportsMessageThreads:
			model.compat?.supportsMessageThreads ??
			(model.provider === "anthropic" && model.baseUrl.includes("api.anthropic.com")),
	};
}

/**
 * Message threads: the server keeps the conversation of a thread, so a request can continue
 * from the previous reply and send only the new messages. pi still builds the full request;
 * `prepareThreadRequest()` compares it with the previous request of the session and sends
 * only the new part when nothing earlier changed.
 */
type ThreadParam = { type: "create" } | { type: "continue"; previous_message_id: string };

/** The pinned SDK types do not include the `thread` request field yet. */
type ThreadedParams = MessageCreateParamsStreaming & { thread?: ThreadParam };

interface ThreadEntry {
	/** Number of messages in the last full request as sent plus the converted reply. */
	prefixCount: number;
	/** `hashThreadPrefix()` of the request's settings and those messages. */
	prefixHash: string;
	/** Id of the reply to continue from. */
	replyId: string;
}

/** Per session: where the next request can continue, or "off" after the endpoint rejected threads. */
const threadState = new Map<string, ThreadEntry | "off">();
const MAX_THREAD_STATE_ENTRIES = 10_000;

/** Rejections of a `continue` that a new thread fixes: expired, raced, or a fixed setting changed. */
const NEW_THREAD_ERRORS: ReadonlySet<string> = new Set([
	"thread_not_found",
	"thread_already_continued",
	"thread_continue_in_flight",
	"thread_fingerprint_mismatch",
]);

/**
 * Sets a session's thread state, keeping at most `MAX_THREAD_STATE_ENTRIES` sessions.
 *
 * State is normally freed by `cleanupSessionResources(sessionId)` when a session ends, as pi's
 * coding agent does. The cap bounds memory for library users that never call it, for example a
 * server passing a new `sessionId` per conversation. Dropping the least recently updated session
 * is cheap: its thread has most likely expired on the server already (after a few minutes idle),
 * and otherwise its next request just starts a new thread.
 */
function setThreadState(sessionId: string, value: ThreadEntry | "off"): void {
	// Re-insert so Map order stays oldest-first for the cap.
	threadState.delete(sessionId);
	threadState.set(sessionId, value);
	if (threadState.size > MAX_THREAD_STATE_ENTRIES) {
		const oldest = threadState.keys().next().value;
		if (oldest !== undefined) threadState.delete(oldest);
	}
}

registerSessionResourceCleanup((sessionId) => {
	if (sessionId) threadState.delete(sessionId);
	else threadState.clear();
});

/**
 * Hash of everything a `continue` builds on: the settings that must stay the same within a thread
 * and the messages the server already holds.
 *
 * - Settings, as sent: the endpoint (a thread exists on one endpoint only), and the fixed request
 *   fields. A `continue` omits `system` and `tools` and the server keeps the thread's own, so only
 *   this check can notice a change to them, including their cache markers. The server rejects
 *   changes to the other fields with `thread_fingerprint_mismatch`; checking them here saves that
 *   rejected request. A fixed field missing here costs only that rejection, which also starts a
 *   new thread.
 * - Messages, normalized so messages that mean the same to the API hash the same.
 */
function hashThreadPrefix(
	model: Model<"anthropic-messages">,
	params: MessageCreateParamsStreaming,
	messages: readonly unknown[],
): string {
	const { system, tools, thinking, output_config, tool_choice, betas, fallbacks } = params;
	const settings = JSON.stringify([
		model.provider,
		model.baseUrl,
		params.model,
		system,
		tools,
		thinking,
		output_config,
		tool_choice,
		betas,
		fallbacks,
	]);
	const conversation = JSON.stringify(messages, (key, value: unknown) => {
		// Cache markers don't change what a message means, but they move: pi puts one on the newest
		// message, so the message that had it in the last request has none in this one. Extensions
		// may add markers anywhere too.
		if (key === "cache_control") return undefined;
		// To attach that marker, the newest user message's string content is sent as one text block;
		// the next request sends the same message as a string: "hi" vs [{ type: "text", text: "hi" }].
		if (key === "content" && typeof value === "string") return [{ type: "text", text: value }];
		return value;
	});
	return shortHash(settings + conversation);
}

interface PreparedThreadRequest {
	sessionId: string;
	body: ThreadedParams;
}

function createThreadRequest(sessionId: string, params: MessageCreateParamsStreaming): PreparedThreadRequest {
	return { sessionId, body: { ...params, thread: { type: "create" } } };
}

function prepareThreadRequest(
	model: Model<"anthropic-messages">,
	sessionId: string,
	params: MessageCreateParamsStreaming,
): PreparedThreadRequest | undefined {
	const state = threadState.get(sessionId);
	if (state === "off") return undefined;
	if (
		state !== undefined &&
		params.messages.length > state.prefixCount &&
		hashThreadPrefix(model, params, params.messages.slice(0, state.prefixCount)) === state.prefixHash
	) {
		// Each reply can be continued once; deleting also keeps a concurrent request from trying.
		threadState.delete(sessionId);
		const { system: _system, tools: _tools, ...rest } = params;
		return {
			body: {
				...rest,
				messages: params.messages.slice(state.prefixCount),
				thread: { type: "continue", previous_message_id: state.replyId },
			},
			sessionId,
		};
	}
	return createThreadRequest(sessionId, params);
}

/** The `error_code` Anthropic puts in `error.details` of thread rejections. */
function getThreadErrorCode(error: InstanceType<typeof Anthropic.APIError>): string | undefined {
	const body = error.error as { error?: { details?: { error_code?: unknown } } } | undefined;
	const code = body?.error?.details?.error_code;
	return typeof code === "string" ? code : undefined;
}

/**
 * Sends a thread request. A rejection (never a started stream) is resent once in full: as a new
 * thread when the old one can't be continued, otherwise without `thread`, which also turns threads
 * off for the session. Returns the response and the thread request that produced it, if any.
 */
async function sendThreadRequest(
	thread: PreparedThreadRequest,
	params: MessageCreateParamsStreaming,
	send: (body: ThreadedParams) => Promise<Response>,
	output: AssistantMessage,
	signal: AbortSignal | undefined,
): Promise<{ response: Response; thread: PreparedThreadRequest | undefined }> {
	try {
		return { response: await send(thread.body), thread };
	} catch (error) {
		// Rate limits and auth errors are not about the thread; strict tool errors go to the
		// strict tool fallback in the caller.
		if (
			signal?.aborted ||
			!(error instanceof Anthropic.APIError) ||
			(error.status !== 400 && error.status !== 404) ||
			isStrictToolLimitErrorMessage(error.message)
		) {
			throw error;
		}
		const errorCode = getThreadErrorCode(error);
		// Recorded before the resend, so a failed resend keeps it.
		appendAssistantMessageDiagnostic(output, {
			type: "anthropic_thread_fallback",
			timestamp: Date.now(),
			error: { message: error.message },
			details: { reason: errorCode ?? String(error.status) },
		});
		if (errorCode !== undefined && NEW_THREAD_ERRORS.has(errorCode)) {
			const created = createThreadRequest(thread.sessionId, params);
			return { response: await send(created.body), thread: created };
		}
		// The endpoint rejects something about threads for this session. With the threads beta, a
		// request without `thread` is a normal request.
		const response = await send(params);
		setThreadState(thread.sessionId, "off");
		return { response, thread: undefined };
	}
}

/**
 * Records where the session's next request can continue: after `output`, the clean reply to the
 * thread request `thread`, whose full request was `params`.
 */
function recordThreadReply(
	model: Model<"anthropic-messages">,
	thread: PreparedThreadRequest,
	params: MessageCreateParamsStreaming,
	output: AssistantMessage,
	isOAuth: boolean,
	allowEmptySignature: boolean,
): void {
	// `responseModel` is set only when a fallback model answered; the server does not store those
	// replies, so they cannot be continued.
	if (output.responseId === undefined || output.responseModel !== undefined) return;
	// Convert the reply like the next request will, keeping only the assistant message
	// (transformMessages adds placeholder results for trailing tool calls).
	const reply = convertMessages(
		transformMessages([output], model, normalizeToolCallId),
		isOAuth,
		undefined,
		allowEmptySignature,
	).messages.filter((message) => message.role === "assistant");
	const prefix = [...params.messages, ...reply];
	setThreadState(thread.sessionId, {
		prefixCount: prefix.length,
		prefixHash: hashThreadPrefix(model, params, prefix),
		replyId: output.responseId,
	});
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimple()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7+, Fable 5)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimple()` maps a simple reasoning
	 * level to this option.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function hasRequestAuth(apiKey: string | undefined, headers: ProviderHeaders | undefined): boolean {
	return (
		!!apiKey ||
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	);
}

function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (!hasRequestAuth(apiKey, headers)) throw new Error(`No API key for provider: ${provider}`);
}

/**
 * Anthropic SDK client that never runs the SDK's own credential chain
 * (ANTHROPIC_PROFILE config files, federation env vars). Without this, every
 * client built with `apiKey: null, authToken: null` for header-owned auth would
 * also resolve and exchange SDK credentials behind pi's auth resolver.
 */
class PiAnthropic extends Anthropic {
	protected override _shouldResolveDefaultCredentials(): boolean {
		return false;
	}
}

type AnthropicFederationConfig = NonNullable<ClientOptions["config"]>;

/**
 * Workload identity federation config from the ANTHROPIC_* variables the
 * Anthropic SDK documents; the SDK performs the token exchange and refresh.
 * Only for the anthropic provider, since the exchange is an Anthropic API
 * endpoint, and only when no key or auth header was resolved.
 */
function getAnthropicFederation(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
	env: ProviderEnv | undefined,
): AnthropicFederationConfig | undefined {
	if (model.provider !== "anthropic" || hasRequestAuth(apiKey, headers)) return undefined;
	const federationRuleId = getProviderEnvValue(ANTHROPIC_FEDERATION_RULE_ID_ENV, env);
	const organizationId = getProviderEnvValue(ANTHROPIC_ORGANIZATION_ID_ENV, env);
	const identityTokenFile = getProviderEnvValue(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, env);
	if (!federationRuleId || !organizationId || !identityTokenFile) return undefined;
	return {
		organization_id: organizationId,
		workspace_id: getProviderEnvValue(ANTHROPIC_WORKSPACE_ID_ENV, env),
		authentication: {
			type: "oidc_federation",
			federation_rule_id: federationRuleId,
			service_account_id: getProviderEnvValue(ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, env),
			identity_token: { source: "file", path: identityTokenFile },
		},
	};
}

/**
 * The SDK caches the federated access token per client, but pi creates a client
 * per request. Keep one client for the current federation config and fetch, and
 * clone it per request with `withOptions()`, which shares the token cache.
 */
let federationClient: { key: string; fetch: typeof globalThis.fetch | undefined; client: Anthropic } | undefined;

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const compat = getAnthropicCompat(model);
	const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const currentTools = getCurrentTools(normalizedContext.messages);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
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

		try {
			let client: Anthropic;
			let isOAuth: boolean;
			let usageModel = model;
			let inputTransformations: BetaInputTransformation[] | undefined;
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			// Session whose requests may use threads; undefined when threads don't apply. Sessions where
			// the endpoint rejected threads ("off") still send the threads beta, which the resend that
			// turned them off was accepted with; `prepareThreadRequest()` just sends no `thread`.
			const threadSessionId = compat.supportsMessageThreads ? cacheSessionId : undefined;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				const federation = getAnthropicFederation(model, apiKey, options?.headers, options?.env);
				if (!federation) assertRequestAuth(model.provider, apiKey, options?.headers);

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(normalizedContext.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: normalizedContext.messages,
						hasImages,
					});
				}

				const created = createClient(
					model,
					apiKey,
					options?.headers,
					options?.fetch,
					copilotDynamicHeaders,
					cacheSessionId,
					federation,
					options?.identity,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const send = (body: ThreadedParams) =>
				retryProviderRequest(() => client.beta.messages.create(body, requestOptions).asResponse(), {
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				});
			let disablePreferredStrictTools = false;
			let response: Response;
			let params: MessageCreateParamsStreaming;
			// The thread request that produced the response; undefined when no `thread` was sent.
			let thread: PreparedThreadRequest | undefined;
			for (;;) {
				options?.signal?.throwIfAborted();
				const built = buildParams(model, normalizedContext, isOAuth, options, {
					disablePreferredStrictTools,
					messageThreads: threadSessionId !== undefined,
				});
				if (built.providerThinkingLevel) output.providerThinkingLevel = built.providerThinkingLevel;
				params = built.params;
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== undefined) {
					params = { ...(nextParams as MessageCreateParamsStreaming), stream: true };
				}
				const prepared =
					threadSessionId !== undefined && options?.disableContinuation !== true
						? prepareThreadRequest(model, threadSessionId, params)
						: undefined;
				try {
					const sent = prepared
						? await sendThreadRequest(prepared, params, send, output, options?.signal)
						: { response: await send(params), thread: undefined };
					response = sent.response;
					thread = sent.thread;
					break;
				} catch (error) {
					// Only downgrade a rejected request, never an already-started stream.
					if (
						options?.signal?.aborted ||
						disablePreferredStrictTools ||
						!built.hasPreferredStrictTools ||
						!(error instanceof Anthropic.APIError) ||
						error.status !== 400 ||
						error.type !== "invalid_request_error" ||
						!isStrictToolLimitErrorMessage(error.message)
					) {
						throw error;
					}
					disablePreferredStrictTools = true;
					appendAssistantMessageDiagnostic(output, {
						type: "anthropic_strict_tools_fallback",
						timestamp: Date.now(),
						error: { message: error.message },
						details: { reason: "strict_tool_limits_exceeded" },
					});
				}
			}
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			// Stream state per Anthropic block index, kept off the content blocks so it never reaches partials.
			const openBlocks = new Map<number, { contentIndex: number; arguments?: ToolCallArgumentsStream }>();
			const openBlock = (anthropicIndex: number) => {
				const open = openBlocks.get(anthropicIndex);
				return open === undefined ? undefined : { ...open, block: output.content[open.contentIndex]! };
			};

			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				await options?.onProviderStreamEvent?.(event, model);
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					const transformations = event.message.input_transformations;
					if (Array.isArray(transformations)) inputTransformations = transformations;
					const responseModel = event.message.model;
					if (responseModel !== model.id) output.responseModel = responseModel;
					const fallbackCost =
						responseModel === model.id
							? undefined
							: model.compat?.allowedFallbackModels?.find(
									(fallback) => fallback.provider === model.provider && fallback.model === responseModel,
								)?.cost;
					usageModel = fallbackCost ? { ...model, id: responseModel, cost: fallbackCost } : model;
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(usageModel, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "fallback") {
						if (output.content.length > 0) {
							throw new Error("Anthropic performed an unsupported mid-output model fallback");
						}
						continue;
					}
					if (event.content_block.type === "text") {
						output.content.push({ type: "text", text: event.content_block.text ?? "" });
						openBlocks.set(event.index, { contentIndex: output.content.length - 1 });
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						output.content.push({
							type: "thinking",
							thinking: event.content_block.thinking ?? "",
							thinkingSignature: event.content_block.signature ?? "",
						});
						openBlocks.set(event.index, { contentIndex: output.content.length - 1 });
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						output.content.push({
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
						});
						openBlocks.set(event.index, { contentIndex: output.content.length - 1 });
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						output.content.push({
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, currentTools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
						});
						openBlocks.set(event.index, {
							contentIndex: output.content.length - 1,
							arguments: new ToolCallArgumentsStream(),
						});
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					const open = openBlock(event.index);
					if (event.delta.type === "text_delta") {
						if (open?.block.type === "text") {
							open.block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: open.contentIndex,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						if (open?.block.type === "thinking") {
							open.block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: open.contentIndex,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						if (open?.block.type === "toolCall" && open.arguments !== undefined) {
							open.block.arguments = open.arguments.append(event.delta.partial_json);
							stream.push({
								type: "toolcall_delta",
								contentIndex: open.contentIndex,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						if (open?.block.type === "thinking") {
							open.block.thinkingSignature = open.block.thinkingSignature || "";
							open.block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const open = openBlock(event.index);
					openBlocks.delete(event.index);
					if (open) {
						const { block, contentIndex: index } = open;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall" && open.arguments !== undefined) {
							Object.assign(block, open.arguments.finish());
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					const transformations = event.input_transformations;
					if (Array.isArray(transformations)) inputTransformations = transformations;
					if (event.delta.stop_reason) {
						output.rawStopReason = event.delta.stop_reason;
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						output.stopReason = stopReasonResult.stopReason;
						if (stopReasonResult.errorMessage) {
							output.errorMessage = stopReasonResult.errorMessage;
						}
					}
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
					if (event.usage) {
						if (event.usage.input_tokens != null) {
							output.usage.input = event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheRead = event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
						}
						// Vercel AI Gateway includes the TTL breakdown in deltas, though the SDK only types it on message_start.
						const cacheCreation = (
							event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
						).cache_creation;
						if (cacheCreation?.ephemeral_1h_input_tokens != null) {
							output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
						}
						// Anthropic reports reasoning tokens as a subset of output tokens.
						const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
						if (thinkingTokens != null) {
							output.usage.reasoning = thinkingTokens;
						}
					}
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(usageModel, output.usage);
					if (isOpenRouterModel(model) && event.usage) {
						// OpenRouter adds billing fields to streamed message_delta usage at runtime,
						// although its OpenAPI schema and the Anthropic SDK do not type those fields.
						applyOpenRouterReportedCost(
							output.usage,
							event.usage as typeof event.usage & OpenRouterUsageAccounting,
						);
					}
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Anthropic stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}
			if (thread) recordThreadReply(model, thread, params, output, isOAuth, compat.allowEmptySignature);
			if (inputTransformations && inputTransformations.length > 0) {
				appendAssistantMessageDiagnostic(output, {
					type: "anthropic_input_transformations",
					timestamp: Date.now(),
					details: {
						transformations: inputTransformations.map((transformation) => ({
							type: transformation.type ?? undefined,
							path: transformation.path ?? undefined,
							reason: transformation.reason ?? undefined,
						})),
					},
				});
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is available on all adaptive-thinking Claude models, while native
 * "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	if (!getAnthropicFederation(model, options?.apiKey, options?.headers, options?.env)) {
		assertRequestAuth(model.provider, options?.apiKey, options?.headers);
	}

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AnthropicOptions;
	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinkingEnabled: false,
		} satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
	federation?: AnthropicFederationConfig,
	identity?: ClientIdentity,
): { client: Anthropic; isOAuthToken: boolean } {
	// Copilot: Bearer auth.
	if (model.provider === "github-copilot") {
		const client = new PiAnthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeHeaders(
				getIdentityHeaders(model, identity),
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers instead of the client identity.
	if (apiKey && isOAuthToken(apiKey)) {
		const client = new PiAnthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key, header-owned auth, or workload identity federation.
	const compat = getAnthropicCompat(model);
	const sessionAffinityHeaders: ProviderHeaders = {};
	if (sessionId && compat.sendSessionAffinityHeaders) {
		const header = compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity";
		sessionAffinityHeaders[header] = sessionId;
	}
	const defaultHeaders = mergeHeaders(
		getIdentityHeaders(model, identity),
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		sessionAffinityHeaders,
		model.headers,
		optionsHeaders,
	);
	if (federation) {
		const key = JSON.stringify([model.baseUrl, federation]);
		if (federationClient?.key !== key || federationClient.fetch !== fetch) {
			const client = new PiAnthropic({
				apiKey: null,
				authToken: null,
				config: federation,
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
				fetch,
			});
			federationClient = { key, fetch, client };
		}
		return { client: federationClient.client.withOptions({ defaultHeaders }), isOAuthToken: false };
	}

	const client = new PiAnthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}

interface BetaFeatureFlags {
	isOAuthToken: boolean;
	/** Tool changes are sent as native `tool_addition` / `tool_removal` blocks. */
	nativeToolChanges: boolean;
	/** The session uses message threads. */
	messageThreads: boolean;
}

function getBetaFeatures(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions | undefined,
	{ isOAuthToken, nativeToolChanges, messageThreads }: BetaFeatureFlags,
): NonNullable<MessageCreateParamsStreaming["betas"]> {
	let configuredFeatures: string | null | undefined;
	for (const headers of [model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() === "anthropic-beta") configuredFeatures = value;
		}
	}
	if (configuredFeatures === null) return [];
	if (configuredFeatures !== undefined) {
		return [
			...new Set(
				configuredFeatures
					.split(",")
					.map((feature) => feature.trim())
					.filter((feature) => feature.length > 0),
			),
		];
	}

	const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
	if (isOAuthToken) features.push("claude-code-20250219", "oauth-2025-04-20");
	if (shouldUseFineGrainedToolStreamingBeta(model, context)) features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	if (
		model.reasoning &&
		options?.thinkingEnabled === true &&
		(options.interleavedThinking ?? true) &&
		model.compat?.forceAdaptiveThinking !== true
	) {
		features.push(INTERLEAVED_THINKING_BETA);
	}
	if (shouldUseServerSideFallbackBeta(model)) features.push(SERVER_SIDE_FALLBACK_BETA);
	if (model.compat?.supportsMidConvoEffort === true) {
		features.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
	}
	if (nativeToolChanges) features.push(INLINE_TOOLS_BETA);
	if (messageThreads) features.push(MESSAGE_THREADS_BETA);
	return [...new Set(features)];
}

interface BuildParamsFlags {
	/** Send `strict: "prefer"` tools without strict schemas, after Anthropic rejected them. */
	disablePreferredStrictTools: boolean;
	/** The session uses message threads, so the threads beta is sent. */
	messageThreads: boolean;
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	isOAuthToken: boolean,
	options: AnthropicOptions | undefined,
	flags: BuildParamsFlags,
): {
	params: MessageCreateParamsStreaming;
	hasPreferredStrictTools: boolean;
	/** Effort of the final effort marker, recorded on the reply so later requests can replay it. */
	providerThinkingLevel: AnthropicEffort | undefined;
} {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const initialSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;
	// Native tool changes keep the request-level tool list fixed and define every later tool
	// by value in a `tool_addition` block, which also expresses same-name redefinitions.
	// Anthropic rejects a tool list where every tool is deferred, so there must be an initial
	// active tool to anchor the placeholder. Otherwise the current tool list is sent.
	let hasPreferredStrictTools = false;
	const convertToolDefinitions = (tools: Tool[], toolCacheControl?: CacheControlEphemeral): BetaTool[] => {
		const definitions = convertTools(
			tools,
			isOAuthToken,
			compat.supportsEagerToolInputStreaming,
			compat.supportsStrictTools,
			toolCacheControl,
			flags.disablePreferredStrictTools,
		);
		if (
			definitions.some(
				(definition, index) => definition.strict === true && prefersJsonSchemaStrictSampling(tools[index]),
			)
		) {
			hasPreferredStrictTools = true;
		}
		return definitions;
	};
	const initialTools = initialSystemMessage?.toolsAdded ?? [];
	const nativeToolChanges =
		compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges && initialTools.length > 0;
	const thinkingDisabled =
		model.reasoning && options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
	// Effort cannot change between messages while thinking is disabled, so "off" sends no effort markers.
	const effortMessages = model.compat?.supportsMidConvoEffort === true && !thinkingDisabled;
	const converted = convertMessages(
		conversationMessages,
		isOAuthToken,
		cacheControl,
		compat.allowEmptySignature,
		effortMessages ? model.provider : undefined,
		nativeToolChanges ? convertToolDefinitions : undefined,
	);
	const activeEffort = options?.effort ?? "high";
	const betaFeatures = getBetaFeatures(model, context, options, {
		isOAuthToken,
		nativeToolChanges,
		messageThreads: flags.messageThreads,
	});
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: effortMessages ? insertThinkingLevelMessages(converted, activeEffort) : converted.messages,
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
		...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (initialSystemText) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(initialSystemText),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (initialSystemText) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(initialSystemText),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (
		options?.temperature !== undefined &&
		!options?.thinkingEnabled &&
		model.compat?.supportsMidConvoEffort !== true &&
		compat.supportsTemperature
	) {
		params.temperature = options.temperature;
	}

	const toolCacheControl = compat.supportsCacheControlOnTools ? cacheControl : undefined;
	if (nativeToolChanges) {
		// Initial tools stay active with the cache breakpoint on the last one, followed by the
		// placeholder. The list never changes afterwards: later tools are defined by value in
		// `tool_addition` blocks and withdrawn by `tool_removal`, so the cached prefix survives
		// every tool change.
		params.tools = [...convertToolDefinitions(initialTools, toolCacheControl), DEFERRED_TOOL_PLACEHOLDER];
	} else {
		const tools = getCurrentTools(context.messages);
		if (tools.length > 0) {
			params.tools = convertToolDefinitions(tools, toolCacheControl);
		}
	}

	if (thinkingDisabled) {
		// No effort is sent, so the model default applies. Anthropic rejects `block_binding`
		// with disabled thinking.
		params.thinking = { type: "disabled" };
	} else if (effortMessages) {
		// Managed effort models use adaptive thinking so prefix mismatches can
		// be dropped instead of surfacing as persistent 400 responses.
		params.thinking = {
			type: "adaptive",
			display: options?.thinkingDisplay ?? "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		};
		// Effort markers set the level for every reply. The top-level effort is part of the cached
		// prompt, so it stays fixed. It is "low" because organizations can cap effort and reject
		// requests containing any level above the cap.
		params.output_config = { effort: "low" };
	} else if (model.reasoning && options?.thinkingEnabled) {
		// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
		// older Claude 4 models (whose API default is also "summarized").
		const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
		if (model.compat?.forceAdaptiveThinking === true) {
			// Adaptive thinking: Claude decides when and how much to think.
			params.thinking = { type: "adaptive", display };
			if (options.effort) {
				params.output_config = { effort: options.effort };
			}
		} else {
			// Budget-based thinking for older models
			params.thinking = {
				type: "enabled",
				budget_tokens: options.thinkingBudgetTokens || 1024,
				display,
			};
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	const allowedFallbackModels = model.compat?.allowedFallbackModels;
	if (allowedFallbackModels && allowedFallbackModels.length > 0) {
		params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));
	}

	return { params, hasPreferredStrictTools, providerThinkingLevel: effortMessages ? activeEffort : undefined };
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertToolResult(msg: ToolResultMessage, content = msg.content): ContentBlockParam {
	return {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content: convertContentBlocks(content),
		is_error: msg.isError,
	};
}

interface ConvertedAnthropicMessages {
	messages: MessageParam[];
	assistantLevels: Map<number, AnthropicEffort>;
}

function convertMessages(
	transformedMessages: Message[],
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
	managedProvider?: string,
	/** Converts tool definitions for native `tool_addition` blocks; undefined when tool changes are not native. */
	convertToolDefinitions?: (tools: Tool[]) => BetaTool[],
): ConvertedAnthropicMessages {
	const params: MessageParam[] = [];
	const assistantLevels = new Map<number, AnthropicEffort>();
	// Later system messages are held back and emitted directly before the next assistant
	// message that is sent (or at the end of the transcript). Assistant messages that convert to
	// no blocks are dropped, so holding past them keeps an update from landing before a user
	// message (#11091). Anthropic requires `tool_result` blocks to
	// immediately follow their `tool_use`, so a system message between them is rejected; this
	// also mirrors where the managed-effort system messages are inserted. As a result an
	// update placed before a user message in the transcript lands after it on the wire.
	const pendingSystemMessages: MessageParam[] = [];
	const flushPendingSystemMessages = (): void => {
		params.push(...pendingSystemMessages);
		pendingSystemMessages.length = 0;
	};

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "system") {
			// Later system messages only reach this point when the model accepts them natively;
			// otherwise the transcript was collapsed into the leading message before conversion.
			const text = renderSystemMessageUpdate(msg);
			const blocks: ContentBlockParam[] = [];
			if (text.length > 0) blocks.push({ type: "text", text: sanitizeSurrogates(text) });
			if (convertToolDefinitions) {
				const added = msg.toolsAdded ?? [];
				const redefined = new Set(added.map((tool) => tool.name));
				for (const tool of msg.toolsRemoved ?? []) {
					// A new definition under the same name replaces the old one, so no removal is needed.
					if (redefined.has(tool.name)) continue;
					blocks.push({
						type: "tool_removal",
						tool: { type: "tool_reference", name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name },
					});
				}
				for (const definition of convertToolDefinitions(added)) {
					blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
				}
			}
			if (blocks.length > 0) pendingSystemMessages.push({ role: "system", content: blocks });
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return convertImageBlock(item);
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const thinkingSignature = block.thinkingSignature;
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!hasThinkingSignature) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			flushPendingSystemMessages();
			const messageIndex = params.length;
			params.push({
				role: "assistant",
				content: blocks,
			});
			if (
				managedProvider !== undefined &&
				msg.api === "anthropic-messages" &&
				msg.provider === managedProvider &&
				isAnthropicEffort(msg.providerThinkingLevel)
			) {
				assistantLevels.set(messageIndex, msg.providerThinkingLevel);
			}
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
			const toolResults: ContentBlockParam[] = [];
			// Anthropic rejects error tool results that contain anything but text, so their images follow
			// all tool results of the turn, which must come first in the user message (#10794).
			const errorImages: ContentBlockParam[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const toolMsg = transformedMessages[j] as ToolResultMessage;
				const split = splitErrorToolResultImages(toolMsg);
				toolResults.push(convertToolResult(toolMsg, split?.content));
				if (split) {
					errorImages.push({ type: "text", text: split.caption }, ...split.images.map(convertImageBlock));
				}
				j++;
			}

			// Skip the messages we've already processed.
			i = j - 1;

			params.push({
				role: "user",
				content: [...toolResults, ...errorImages],
			});
		}
	}

	flushPendingSystemMessages();

	// Add cache_control to the last user or system message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user" || lastMessage.role === "system") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" ||
						lastBlock.type === "image" ||
						lastBlock.type === "tool_result" ||
						lastBlock.type === "tool_addition" ||
						lastBlock.type === "tool_removal")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return { messages: params, assistantLevels };
}

function isAnthropicEffort(value: unknown): value is AnthropicEffort {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function insertThinkingLevelMessages(
	converted: ConvertedAnthropicMessages,
	activeEffort: AnthropicEffort,
): MessageParam[] {
	const messages: MessageParam[] = [];
	for (let index = 0; index < converted.messages.length; index++) {
		const historicalEffort = converted.assistantLevels.get(index);
		if (historicalEffort !== undefined) {
			messages.push({ role: "system", content: [], output_config: { effort: historicalEffort } });
		}
		messages.push(converted.messages[index]);
	}
	messages.push({ role: "system", content: [], output_config: { effort: activeEffort } });
	return messages;
}

function shouldUseFineGrainedToolStreamingBeta(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
): boolean {
	return getCurrentTools(context.messages).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

// Keywords Anthropic strict tool use rejects with a 400 for the whole request.
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"maxItems",
	"uniqueItems",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
]);
const ANTHROPIC_STRICT_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);

const isAnthropicStrictUnsupportedKeyword: UnsupportedStrictSchemaKeywordCheck = (key, value) => {
	if (ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS.has(key)) return true;
	if (key === "minItems") return value !== 0 && value !== 1;
	if (key === "format") return typeof value !== "string" || !ANTHROPIC_STRICT_STRING_FORMATS.has(value);
	return false;
};

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	supportsStrictTools: boolean,
	cacheControl?: CacheControlEphemeral,
	disablePreferredStrictTools = false,
): BetaTool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const strict =
			disablePreferredStrictTools && prefersJsonSchemaStrictSampling(tool)
				? undefined
				: resolveJsonSchemaStrictSampling(tool, supportsStrictTools, isAnthropicStrictUnsupportedKeyword);
		const parameters = getJsonSchemaToolParameters(tool, strict);
		const schema = parameters as { properties?: unknown; required?: string[] };
		const legacyInputSchema = {
			type: "object" as const,
			properties: schema.properties ?? {},
			required: schema.required ?? [],
		};
		const inputSchema =
			strict === true
				? {
						...(parameters as Record<string, unknown>),
						...legacyInputSchema,
					}
				: legacyInputSchema;

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(strict === true ? { strict: true } : {}),
			input_schema: inputSchema,
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(
	reason: BetaStopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
