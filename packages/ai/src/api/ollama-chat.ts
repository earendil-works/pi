import { clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools } from "../utils/transcript.ts";
import { transformMessages } from "./transform-messages.ts";

export interface OllamaOptions extends StreamOptions {
	/** Maximum wait for response headers or the next non-empty body chunk, in milliseconds. */
	timeoutMs?: number;
	think?: boolean | "low" | "medium" | "high" | "max";
	keepAlive?: string | number;
	toolChoice?: "auto" | "none";
}

interface OllamaMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	thinking?: string;
	images?: string[];
	tool_calls?: { id: string; function: { name: string; arguments: Record<string, unknown> } }[];
	tool_name?: string;
	tool_call_id?: string;
}

function convertMessages(context: TranscriptContext, model: Model<"ollama-chat">): OllamaMessage[] {
	const result: OllamaMessage[] = [];
	for (const message of transformMessages(context.messages, model)) {
		if (message.role === "system") {
			const content = getSystemMessageText(message);
			if (content) result.push({ role: "system", content });
			continue;
		}
		const blocks =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const converted: OllamaMessage = {
			role: message.role === "toolResult" ? "tool" : message.role,
			content: blocks
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		};
		const thinking = blocks
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking)
			.join("");
		if (thinking) converted.thinking = thinking;
		const images = blocks.filter((block) => block.type === "image").map((block) => block.data);
		if (images.length) converted.images = images;
		const calls = blocks.filter((block) => block.type === "toolCall");
		if (calls.length)
			converted.tool_calls = calls.map((call) => ({
				id: call.id,
				function: { name: call.name, arguments: call.arguments },
			}));
		if (message.role === "toolResult") {
			converted.tool_name = message.toolName;
			converted.tool_call_id = message.toolCallId;
		}
		result.push(converted);
	}
	return result;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Native NDJSON transport. A failed or incomplete response must never release tools to the agent. */
export const stream: StreamFunction<"ollama-chat", OllamaOptions> = (model, context, options = {}) => {
	const events = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "pending",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	void (async () => {
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const timeoutController = options.timeoutMs === undefined ? undefined : new AbortController();
		const resetIdleTimeout = () => {
			if (!timeoutController || options.timeoutMs === undefined) return;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(
				() => timeoutController.abort(new Error(`Ollama request idle timeout after ${options.timeoutMs}ms`)),
				options.timeoutMs,
			);
		};
		let active: number | undefined;
		const endBlock = () => {
			if (active === undefined) return;
			const block = message.content[active];
			if (block.type === "text")
				events.push({ type: "text_end", contentIndex: active, content: block.text, partial: message });
			if (block.type === "thinking")
				events.push({ type: "thinking_end", contentIndex: active, content: block.thinking, partial: message });
			active = undefined;
		};
		const append = (type: "text" | "thinking", value: unknown) => {
			if (value === undefined || value === "") return;
			if (typeof value !== "string") throw new Error(`Invalid Ollama ${type} chunk`);
			if (active === undefined || message.content[active].type !== type) {
				endBlock();
				active = message.content.length;
				message.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" });
				events.push({ type: `${type}_start`, contentIndex: active, partial: message });
			}
			const block = message.content[active];
			if (block.type === "text") block.text += value;
			if (block.type === "thinking") block.thinking += value;
			events.push({ type: `${type}_delta`, contentIndex: active, delta: value, partial: message });
		};
		try {
			// Model templates differ in support for later system messages. Replay
			// prompt sections and tool changes into the current request state.
			const transcript = collapseSystemMessages(context);
			const tools = getCurrentTools(transcript.messages);
			const maxTokens = options.maxTokens ?? model.maxTokens;
			if (
				!Number.isSafeInteger(model.contextWindow) ||
				model.contextWindow < 2 ||
				!Number.isSafeInteger(maxTokens) ||
				maxTokens < 1
			) {
				throw new Error("Ollama contextWindow and maxTokens must be positive integers (contextWindow >= 2)");
			}
			if (
				options.timeoutMs !== undefined &&
				(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 2147483647)
			) {
				throw new Error("Ollama timeoutMs must be an integer between 0 and 2147483647");
			}
			const signal = timeoutController
				? AbortSignal.any([...(options.signal ? [options.signal] : []), timeoutController.signal])
				: options.signal;
			signal?.throwIfAborted();
			const headers = new Headers({ "content-type": "application/json" });
			if (options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
			for (const source of [model.headers, options.headers]) {
				for (const [key, value] of Object.entries(source ?? {})) {
					if (value === null) headers.delete(key);
					else headers.set(key, value);
				}
			}
			let payload: unknown = {
				model: model.id,
				messages: convertMessages(transcript, model),
				stream: true,
				// Ollama 0.20+: report overflow instead of silently losing conversation history.
				truncate: false,
				shift: false,
				...(model.reasoning ? { think: options.think ?? false } : {}),
				...(options.keepAlive !== undefined ? { keep_alive: options.keepAlive } : {}),
				...(options.toolChoice !== "none" && tools.length
					? {
							tools: tools.map((tool) => ({
								type: "function",
								function: { name: tool.name, description: tool.description, parameters: tool.parameters },
							})),
						}
					: {}),
				options: {
					...model.samplingParams,
					...options.samplingParams,
					...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
					num_ctx: model.contextWindow,
					num_predict: Math.min(maxTokens, model.contextWindow - 1),
				},
			};
			payload = (await options.onPayload?.(payload, model)) ?? payload;
			signal?.throwIfAborted();
			const baseUrl = options.env?.OLLAMA_BASE_URL ?? model.baseUrl;
			resetIdleTimeout();
			const response = await (options.fetch ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/api/chat`, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal,
			});
			try {
				signal?.throwIfAborted();
				resetIdleTimeout();
				await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
				if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
			} catch (error) {
				await response.body?.cancel().catch(() => {});
				throw error;
			}
			if (!response.body) throw new Error("Ollama response has no body");
			reader = response.body.getReader();
			events.push({ type: "start", partial: message });
			const decoder = new TextDecoder();
			let buffer = "";
			let done = false;
			const processRecord = (line: string) => {
				if (!line.trim()) return;
				const record: unknown = JSON.parse(line);
				if (!object(record)) throw new Error("Invalid Ollama stream record");
				if (record.error) throw new Error(String(record.error));
				if (object(record.message)) {
					append("thinking", record.message.thinking);
					append("text", record.message.content);
					const calls = record.message.tool_calls;
					if (calls !== undefined && !Array.isArray(calls)) throw new Error("Invalid Ollama tool calls");
					for (const call of calls ?? []) {
						if (
							!object(call) ||
							!object(call.function) ||
							typeof call.function.name !== "string" ||
							!call.function.name ||
							!object(call.function.arguments)
						) {
							throw new Error("Invalid Ollama tool call: expected a name and an arguments object");
						}
						endBlock();
						// Native calls may omit IDs, or restart indexing on each response.
						const toolCall: ToolCall = {
							type: "toolCall",
							id: `ollama_${crypto.randomUUID()}`,
							name: call.function.name,
							arguments: call.function.arguments,
						};
						const contentIndex = message.content.length;
						message.content.push(toolCall);
						events.push({ type: "toolcall_start", contentIndex, partial: message });
						events.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
					}
				}
				if (record.done === true) {
					if (
						record.done_reason !== undefined &&
						record.done_reason !== "stop" &&
						record.done_reason !== "length"
					) {
						throw new Error(`Unexpected Ollama done_reason: ${record.done_reason}`);
					}
					endBlock();
					done = true;
					const input = tokenCount(record.prompt_eval_count);
					message.usage.cacheRead = Math.min(input, tokenCount(record.prompt_eval_cached_count));
					message.usage.input = input - message.usage.cacheRead;
					message.usage.output = tokenCount(record.eval_count);
					message.usage.totalTokens = input + message.usage.output;
					message.rawStopReason = record.done_reason;
					message.stopReason =
						record.done_reason === "length"
							? "length"
							: message.content.some((block) => block.type === "toolCall")
								? "toolUse"
								: "stop";
				}
			};
			while (!done) {
				signal?.throwIfAborted();
				const chunk = await (signal ? raceWithAbortSignal(reader.read(), signal) : reader.read());
				if (!chunk.done && chunk.value.byteLength > 0) resetIdleTimeout();
				buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (!done && newline >= 0) {
					processRecord(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
				if (buffer.length > 16 * 1024 * 1024) throw new Error("Ollama stream record exceeds 16 MiB");
				if (chunk.done) {
					if (!done && buffer.trim()) processRecord(buffer);
					break;
				}
			}
			signal?.throwIfAborted();
			if (!done) throw new Error("Ollama stream ended before done=true");
			events.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
		} catch (error) {
			message.stopReason = options.signal?.aborted ? "aborted" : "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			events.push({ type: "error", reason: message.stopReason, error: message });
		} finally {
			clearTimeout(idleTimer);
			if (reader) {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			events.end(message);
		}
	})();
	return events;
};

export const streamSimple: StreamFunction<"ollama-chat", SimpleStreamOptions> = (model, context, options = {}) => {
	const level = clampThinkingLevel(model, options.reasoning ?? "off");
	const mapped = model.thinkingLevelMap?.[level];
	const think =
		mapped === "low" || mapped === "medium" || mapped === "high" || mapped === "max"
			? mapped
			: mapped === "false"
				? false
				: level !== "off";
	return stream(model, context, { ...options, think });
};
