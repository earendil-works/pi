/**
 * Google Interactions API on the Google AI Ultra plan: `POST <baseUrl>/interactions:createPerUserQuota`, with
 * the OAuth access token in the `Authorization` header (set by the provider's auth).
 *
 * Stateless use only: every request sends `store: false` and the full conversation as typed steps
 * (`user_input`, `thought`, `function_call`, `function_result`, `model_output`). The response is an SSE
 * stream of step events (`step.start`, `step.delta`, `step.stop`) closed by `interaction.completed`.
 */

import type { Interactions } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { parseToolCallArguments } from "../utils/json-parse.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { SseDecoder } from "../utils/sse.ts";
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
import { getSystemMessageText } from "../utils/text.ts";
import {
	collapseSystemMessages,
	getCurrentTools,
	getInitialSystemMessage,
	withoutInitialSystemMessage,
} from "../utils/transcript.ts";
import { getJsonSchemaToolParameters } from "./constrained-sampling.ts";
import { classifyGoogleInteractionsError } from "./google-interactions-errors.ts";
import { type ResolvedGoogleThinkingLevel, resolveGoogleThinkingLevel } from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export interface GoogleInteractionsOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	/** Sent as `generation_config.thinking_level`; omitted means the model default. */
	thinkingLevel?: ResolvedGoogleThinkingLevel;
}

type Step = Interactions.Step;
type SseEvent = Interactions.InteractionSSEEvent;
type InteractionRequest = {
	model: string;
	store: false;
	stream: true;
	input: Step[];
	system_instruction?: string;
	tools?: Interactions.Tool[];
	generation_config?: Interactions.GenerationConfig;
};

/**
 * HTTP failure that `retryProviderRequest` may retry, deciding by `status` and `headers`. Final failures are thrown
 * as plain errors. No `body` field, so `normalizeProviderError` keeps the readable message.
 */
class GoogleInteractionsResponseError extends Error {
	readonly status: number;
	readonly headers: Headers;

	constructor(status: number, headers: Headers, message: string) {
		super(message);
		this.name = "GoogleInteractionsResponseError";
		this.status = status;
		this.headers = headers;
	}
}

export const stream: StreamFunction<"google-interactions", GoogleInteractionsOptions> = (
	model: Model<"google-interactions">,
	context: TranscriptContext,
	options?: GoogleInteractionsOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
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
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const hasAuthorization = Object.keys(options?.headers ?? {}).some(
				(name) => name.toLowerCase() === "authorization",
			);
			if (!hasAuthorization) throw new Error(`No credentials for provider: ${model.provider}`);
			const url = `${model.baseUrl.replace(/\/+$/u, "")}/interactions:createPerUserQuota`;
			let payload: unknown = buildRequest(model, context, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) payload = nextPayload;

			const response = await retryProviderRequest(
				async () => {
					// `timeoutMs` covers only the wait for the response headers, as in the other APIs: turns can stream for
					// many minutes, and stalls in the body are left to the HTTP client's idle timeout. The caller's signal
					// stays attached so an abort still stops the stream.
					const timeoutMs = options?.timeoutMs;
					const headerTimeout = new AbortController();
					const timer =
						timeoutMs !== undefined && timeoutMs > 0
							? setTimeout(
									() =>
										headerTimeout.abort(new Error(`Google response headers timed out after ${timeoutMs}ms`)),
									timeoutMs,
								)
							: undefined;
					const signal = options?.signal
						? AbortSignal.any([options.signal, headerTimeout.signal])
						: headerTimeout.signal;
					let res: Response;
					try {
						res = await (options?.fetch ?? globalThis.fetch)(url, {
							method: "POST",
							headers: providerHeadersToRecord(
								getIdentityHeaders(model, options?.identity),
								{ accept: "text/event-stream", "content-type": "application/json" },
								options?.headers,
							),
							body: JSON.stringify(payload),
							signal,
						});
					} finally {
						clearTimeout(timer);
					}
					await options?.onResponse?.({ status: res.status, headers: headersToRecord(res.headers) }, model);
					if (!res.ok) {
						const { status, headers } = res;
						const error = classifyGoogleInteractionsError({
							status,
							headers,
							body: await res.text(),
							modelId: model.id,
						});
						throw error.final
							? new Error(error.message)
							: new GoogleInteractionsResponseError(status, headers, error.message);
					}
					return res;
				},
				{ maxRetries: options?.maxRetries, maxRetryDelayMs: options?.maxRetryDelayMs, signal: options?.signal },
			);
			if (!response.body) throw new Error(`${model.provider} response has no body`);

			eventStream.push({ type: "start", partial: output });
			const converter = new StepConverter(model, output, (event) => eventStream.push(event));
			for await (const event of readSseEvents(response.body)) {
				await options?.onProviderStreamEvent?.(event, model);
				converter.handle(event);
				if (converter.status !== undefined) break;
			}

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			// A stream that closes before interaction.completed is an interrupted turn, not a short answer.
			if (converter.status === undefined) throw new Error("Google stream ended before interaction.completed");
			output.rawStopReason = converter.status;
			const reason = mapStatus(converter.status);
			if (reason === "error") throw new Error(`Interaction ended with status ${converter.status}`);
			output.stopReason = reason;

			eventStream.push({ type: "done", reason, message: output });
			eventStream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			eventStream.push({ type: "error", reason: output.stopReason, error: output });
			eventStream.end();
		}
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<"google-interactions", SimpleStreamOptions> = (
	model: Model<"google-interactions">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = { ...buildBaseOptions(model, context, options), toolChoice: options?.toolChoice };
	// Gemini 4 models cannot turn thinking off; clamping picks the nearest supported level.
	const level = clampThinkingLevel(model, options?.reasoning ?? "off");
	if (level === "off") return stream(model, context, base);
	return stream(model, context, { ...base, thinkingLevel: resolveGoogleThinkingLevel(model, level) });
};

function buildRequest(
	model: Model<"google-interactions">,
	context: TranscriptContext,
	options: GoogleInteractionsOptions | undefined,
): InteractionRequest {
	const normalized = collapseSystemMessages(context);
	const systemMessage = getInitialSystemMessage(normalized.messages);
	const systemInstruction = systemMessage ? getSystemMessageText(systemMessage) : "";
	const tools = getCurrentTools(normalized.messages);

	const generationConfig: Interactions.GenerationConfig = {};
	if (options?.thinkingLevel) {
		generationConfig.thinking_level = options.thinkingLevel;
		generationConfig.thinking_summaries = "auto";
	}
	if (options?.maxTokens !== undefined) generationConfig.max_output_tokens = options.maxTokens;
	if (tools.length > 0 && options?.toolChoice) generationConfig.tool_choice = options.toolChoice;

	return {
		model: model.id,
		store: false,
		stream: true,
		...(systemInstruction && { system_instruction: sanitizeSurrogates(systemInstruction) }),
		...(tools.length > 0 && {
			tools: tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, false),
			})),
		}),
		...(Object.keys(generationConfig).length > 0 && { generation_config: generationConfig }),
		input: convertMessages(model, normalized),
	};
}

/** Signature value Google documents for replaying function calls the model did not sign. */
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** Convert the transcript to Interactions steps. Signed thought steps are kept only for the same model. */
function convertMessages(model: Model<"google-interactions">, context: TranscriptContext): Step[] {
	const messages = transformMessages(withoutInitialSystemMessage(context.messages), model);
	const steps: Step[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const content =
				typeof message.content === "string"
					? [{ type: "text" as const, text: sanitizeSurrogates(message.content) }]
					: message.content.map(convertContent);
			if (content.length > 0) steps.push({ type: "user_input", content });
		} else if (message.role === "assistant") {
			// transformMessages already dropped thinking and tool-call signatures from other models.
			let signed = false;
			for (const block of message.content) {
				if (block.type === "thinking") {
					signed ||= Boolean(block.thinkingSignature);
					steps.push({
						type: "thought",
						...(block.thinkingSignature && { signature: block.thinkingSignature }),
						...(block.thinking.trim() && {
							summary: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
						}),
					});
				} else if (block.type === "text") {
					if (!block.text) continue;
					const previous = steps.at(-1);
					const text = { type: "text" as const, text: sanitizeSurrogates(block.text) };
					if (previous?.type === "model_output") previous.content = [...(previous.content ?? []), text];
					else steps.push({ type: "model_output", content: [text] });
				} else if (block.type === "toolCall") {
					// Gemini rejects function calls of the current turn without a signed thought step before them, e.g.
					// after switching from another model mid tool loop. Google's sentinel skips the check.
					if (!signed) {
						steps.push({ type: "thought", signature: SKIP_THOUGHT_SIGNATURE });
						signed = true;
					}
					steps.push({ type: "function_call", id: block.id, name: block.name, arguments: block.arguments });
				}
			}
		} else if (message.role === "toolResult") {
			// transformMessages already replaced images when the model does not support them.
			const images = message.content.filter((c): c is ImageContent => c.type === "image");
			const text = message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			steps.push({
				type: "function_result",
				call_id: message.toolCallId,
				name: message.toolName,
				result:
					images.length > 0
						? [
								...(text ? [{ type: "text" as const, text: sanitizeSurrogates(text) }] : []),
								...images.map(convertContent),
							]
						: sanitizeSurrogates(text),
				...(message.isError && { is_error: true }),
			});
		}
	}
	return steps;
}

function convertContent(content: TextContent | ImageContent): Interactions.TextContent | Interactions.ImageContent {
	return content.type === "text"
		? { type: "text", text: sanitizeSurrogates(content.text) }
		: { type: "image", mime_type: content.mimeType, data: content.data };
}

/** Builds the assistant message from step events and emits pi stream events. */
class StepConverter {
	/** Final interaction status, set by `interaction.completed`. */
	status: string | undefined;
	private readonly model: Model<"google-interactions">;
	private readonly output: AssistantMessage;
	private readonly emit: (event: AssistantMessageEvent) => void;
	/** Content index of each open step, keyed by the step index on the wire. */
	private readonly blocks = new Map<number, number>();
	private readonly toolArguments = new Map<number, ToolCallArgumentsStream>();

	constructor(
		model: Model<"google-interactions">,
		output: AssistantMessage,
		emit: (event: AssistantMessageEvent) => void,
	) {
		this.model = model;
		this.output = output;
		this.emit = emit;
	}

	handle(event: SseEvent): void {
		switch (event.event_type) {
			case "step.start":
				this.start(event.index, event.step);
				break;
			case "step.delta":
				this.delta(event.index, event.delta);
				break;
			case "step.stop":
				this.stop(event.index);
				break;
			case "interaction.completed": {
				const { status, usage, id } = event.interaction;
				this.output.responseId ||= id;
				if (usage) this.setUsage(usage);
				this.status = status;
				break;
			}
			case "error":
				throw new Error(event.error?.message ?? "Google stream error");
		}
	}

	private start(index: number, step: Step): void {
		const content = this.output.content;
		if (step.type === "thought") {
			content.push({ type: "thinking", thinking: "", ...(step.signature && { thinkingSignature: step.signature }) });
			this.blocks.set(index, content.length - 1);
			this.emit({ type: "thinking_start", contentIndex: content.length - 1, partial: this.output });
		} else if (step.type === "model_output") {
			content.push({ type: "text", text: "" });
			this.blocks.set(index, content.length - 1);
			this.emit({ type: "text_start", contentIndex: content.length - 1, partial: this.output });
		} else if (step.type === "function_call") {
			content.push({ type: "toolCall", id: step.id, name: step.name, arguments: {} });
			this.blocks.set(index, content.length - 1);
			this.toolArguments.set(index, new ToolCallArgumentsStream());
			this.emit({ type: "toolcall_start", contentIndex: content.length - 1, partial: this.output });
		}
		// Server-side tool steps (code execution, URL context, search) are not sent and not shown yet.
	}

	private delta(index: number, delta: Interactions.StepDelta["delta"]): void {
		const contentIndex = this.blocks.get(index);
		if (contentIndex === undefined) return;
		const block = this.output.content[contentIndex];
		if (delta.type === "text" && block.type === "text") {
			block.text += delta.text;
			this.emit({ type: "text_delta", contentIndex, delta: delta.text, partial: this.output });
		} else if (delta.type === "thought_summary" && block.type === "thinking") {
			const text = delta.content?.type === "text" ? delta.content.text : "";
			if (!text) return;
			block.thinking += text;
			this.emit({ type: "thinking_delta", contentIndex, delta: text, partial: this.output });
		} else if (delta.type === "thought_signature" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + (delta.signature ?? "");
		} else if (delta.type === "arguments_delta" && block.type === "toolCall") {
			const args = this.toolArguments.get(index);
			if (!args || !delta.arguments) return;
			block.arguments = args.append(delta.arguments);
			this.emit({ type: "toolcall_delta", contentIndex, delta: delta.arguments, partial: this.output });
		}
	}

	private stop(index: number): void {
		const contentIndex = this.blocks.get(index);
		if (contentIndex === undefined) return;
		this.blocks.delete(index);
		const block = this.output.content[contentIndex];
		if (block.type === "text") {
			this.emit({ type: "text_end", contentIndex, content: block.text, partial: this.output });
		} else if (block.type === "thinking") {
			this.emit({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
		} else if (block.type === "toolCall") {
			const args = this.toolArguments.get(index);
			this.toolArguments.delete(index);
			Object.assign(block, parseToolCallArguments(args?.text));
			this.emit({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.output });
		}
	}

	private setUsage(usage: Interactions.Usage): void {
		const cached = usage.total_cached_tokens ?? 0;
		const thought = usage.total_thought_tokens ?? 0;
		this.output.usage = {
			input: (usage.total_input_tokens ?? 0) - cached,
			output: (usage.total_output_tokens ?? 0) + thought,
			cacheRead: cached,
			cacheWrite: 0,
			reasoning: thought,
			totalTokens: usage.total_tokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(this.model, this.output.usage);
	}
}

function mapStatus(status: string): Extract<StopReason, "stop" | "toolUse" | "length" | "error"> {
	switch (status) {
		case "completed":
			return "stop";
		case "requires_action":
			return "toolUse";
		case "incomplete":
			return "length";
		default:
			return "error";
	}
}

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const sse = new SseDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			for (const { data } of done ? sse.end() : sse.push(value)) {
				// Google sends `[DONE]` after `interaction.completed`.
				if (data && data !== "[DONE]") yield JSON.parse(data) as SseEvent;
			}
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}
