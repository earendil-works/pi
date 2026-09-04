import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { parseStreamingJson } from "./json-parse.ts";

/**
 * Compact, replayable assistant-message progress. Terminal settlement is
 * intentionally excluded and must be persisted separately.
 */
export type AssistantMessageFrame =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; content: TextContent }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string; textSignature?: string }
	| { type: "thinking_start"; contentIndex: number; content: ThinkingContent }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			thinkingSignature?: string;
			redacted?: boolean;
	  }
	| { type: "toolcall_start"; contentIndex: number; toolCall: ToolCall }
	| { type: "toolcall_checkpoint"; contentIndex: number; json: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| {
			type: "toolcall_end";
			contentIndex: number;
			id: string;
			name: string;
			arguments: ToolCall["arguments"];
			thoughtSignature?: string;
			namespace?: string;
	  };

type EncoderBlockState =
	| { kind: "text" | "thinking"; coveredChars: number; deltaChars: number }
	| {
			kind: "toolCall";
			caughtUp: boolean;
			catchupJson: string;
			snapshotArguments: string;
	  };

type ReducerBlockState =
	| { kind: "text"; ended: boolean }
	| { kind: "thinking"; ended: boolean }
	| { kind: "toolCall"; ended: boolean; json: string };

function cloneTextContent(content: TextContent): TextContent {
	return {
		type: "text",
		text: content.text,
		...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
	};
}

function cloneThinkingContent(content: ThinkingContent): ThinkingContent {
	return {
		type: "thinking",
		thinking: content.thinking,
		...(content.thinkingSignature === undefined ? {} : { thinkingSignature: content.thinkingSignature }),
		...(content.redacted === undefined ? {} : { redacted: content.redacted }),
	};
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
	return {
		type: "toolCall",
		id: toolCall.id,
		name: toolCall.name,
		arguments: structuredClone(toolCall.arguments),
		...(toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: toolCall.thoughtSignature }),
		...(toolCall.namespace === undefined ? {} : { namespace: toolCall.namespace }),
	};
}

function cloneStartMessage(message: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: message.api,
		provider: message.provider,
		model: message.model,
		...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
		...(message.responseId === undefined ? {} : { responseId: message.responseId }),
		...(message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel }),
		...(message.diagnostics === undefined ? {} : { diagnostics: structuredClone(message.diagnostics) }),
		usage: structuredClone(message.usage),
		stopReason: "pending",
		timestamp: message.timestamp,
	};
}

function assertContentIndex(contentIndex: number): void {
	if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) {
		throw new Error(`Invalid assistant message frame contentIndex: ${contentIndex}`);
	}
}

function eventBlock(event: Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>) {
	assertContentIndex(event.contentIndex);
	const block = event.partial.content[event.contentIndex];
	if (!block) {
		throw new Error(`${event.type} event has no content block at index ${event.contentIndex}`);
	}
	return block;
}

function serializedArguments(argumentsValue: ToolCall["arguments"]): string {
	const serialized = JSON.stringify(argumentsValue);
	if (serialized === undefined) throw new Error("Tool-call arguments are not JSON-serializable");
	return serialized;
}

const EMPTY_PARSED_TOOL_ARGUMENTS = serializedArguments(parseStreamingJson<ToolCall["arguments"]>(""));

function isJsonPrefix(snapshot: unknown, current: unknown): boolean {
	if (typeof snapshot === "string") return typeof current === "string" && current.startsWith(snapshot);
	if (Array.isArray(snapshot)) {
		return (
			Array.isArray(current) &&
			snapshot.length <= current.length &&
			snapshot.every((value, index) => isJsonPrefix(value, current[index]))
		);
	}
	if (typeof snapshot !== "object" || snapshot === null) return Object.is(snapshot, current);
	if (typeof current !== "object" || current === null || Array.isArray(current)) return false;
	const currentRecord = current as Record<string, unknown>;
	return Object.entries(snapshot).every(
		([key, value]) => Object.hasOwn(currentRecord, key) && isJsonPrefix(value, currentRecord[key]),
	);
}

/**
 * Encodes one assistant stream. `partial` remains a shared live accumulator;
 * the encoder uses per-block offsets to avoid replaying deltas already visible
 * when an older queued event is consumed.
 */
export class AssistantMessageFrameEncoder {
	private started = false;
	private terminal = false;
	private readonly blocks = new Map<number, EncoderBlockState>();

	encode(event: AssistantMessageEvent): AssistantMessageFrame | undefined {
		if (this.terminal) throw new Error(`Assistant message event ${event.type} follows a terminal event`);

		switch (event.type) {
			case "start":
				if (this.started) throw new Error("Assistant message stream contains more than one start event");
				this.started = true;
				return { type: "start", partial: cloneStartMessage(event.partial) };
			case "done":
				if (!this.started) throw new Error("Assistant message done event appears before start");
				this.terminal = true;
				return undefined;
			case "error":
				this.terminal = true;
				return undefined;
		}

		if (!this.started) throw new Error(`Assistant message ${event.type} event appears before start`);

		switch (event.type) {
			case "text_start": {
				const content = eventBlock(event);
				if (content.type !== "text") {
					throw new Error(`text_start event points to ${content.type} block at index ${event.contentIndex}`);
				}
				this.startBlock(event.contentIndex, {
					kind: "text",
					coveredChars: content.text.length,
					deltaChars: 0,
				});
				return { type: "text_start", contentIndex: event.contentIndex, content: cloneTextContent(content) };
			}
			case "text_delta":
				return this.encodeTextDelta(event.contentIndex, event.delta, "text");
			case "text_end": {
				const content = eventBlock(event);
				if (content.type !== "text") {
					throw new Error(`text_end event points to ${content.type} block at index ${event.contentIndex}`);
				}
				this.endBlock(event.contentIndex, "text");
				return {
					type: "text_end",
					contentIndex: event.contentIndex,
					content: event.content,
					...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
				};
			}
			case "thinking_start": {
				const content = eventBlock(event);
				if (content.type !== "thinking") {
					throw new Error(`thinking_start event points to ${content.type} block at index ${event.contentIndex}`);
				}
				this.startBlock(event.contentIndex, {
					kind: "thinking",
					coveredChars: content.thinking.length,
					deltaChars: 0,
				});
				return {
					type: "thinking_start",
					contentIndex: event.contentIndex,
					content: cloneThinkingContent(content),
				};
			}
			case "thinking_delta":
				return this.encodeTextDelta(event.contentIndex, event.delta, "thinking");
			case "thinking_end": {
				const content = eventBlock(event);
				if (content.type !== "thinking") {
					throw new Error(`thinking_end event points to ${content.type} block at index ${event.contentIndex}`);
				}
				this.endBlock(event.contentIndex, "thinking");
				return {
					type: "thinking_end",
					contentIndex: event.contentIndex,
					content: event.content,
					...(content.thinkingSignature === undefined ? {} : { thinkingSignature: content.thinkingSignature }),
					...(content.redacted === undefined ? {} : { redacted: content.redacted }),
				};
			}
			case "toolcall_start": {
				const content = eventBlock(event);
				if (content.type !== "toolCall") {
					throw new Error(`toolcall_start event points to ${content.type} block at index ${event.contentIndex}`);
				}
				const snapshotArguments = serializedArguments(content.arguments);
				const caughtUp = snapshotArguments === EMPTY_PARSED_TOOL_ARGUMENTS;
				this.startBlock(event.contentIndex, {
					kind: "toolCall",
					caughtUp,
					catchupJson: "",
					snapshotArguments: caughtUp ? "" : snapshotArguments,
				});
				return { type: "toolcall_start", contentIndex: event.contentIndex, toolCall: cloneToolCall(content) };
			}
			case "toolcall_delta": {
				const state = this.block(event.contentIndex, "toolCall");
				if (state.kind !== "toolCall") throw new Error("Unreachable tool-call encoder state");
				if (state.caughtUp) {
					return event.delta.length === 0
						? undefined
						: { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
				}
				state.catchupJson += event.delta;
				const argumentsValue = parseStreamingJson<ToolCall["arguments"]>(state.catchupJson);
				if (serializedArguments(argumentsValue) !== state.snapshotArguments) {
					// Legacy grammar calls include the initial input in toolcall_start, but their
					// JSON delta stream still begins at an empty input. Its parsed arguments can
					// therefore extend, rather than exactly reproduce, the start snapshot.
					const snapshotArguments = parseStreamingJson<ToolCall["arguments"]>(state.snapshotArguments);
					if (!isJsonPrefix(snapshotArguments, argumentsValue)) return undefined;
				}
				state.caughtUp = true;
				state.snapshotArguments = "";
				const json = state.catchupJson;
				state.catchupJson = "";
				return json.length === 0
					? undefined
					: { type: "toolcall_checkpoint", contentIndex: event.contentIndex, json };
			}
			case "toolcall_end": {
				const content = eventBlock(event);
				if (content.type !== "toolCall") {
					throw new Error(`toolcall_end event points to ${content.type} block at index ${event.contentIndex}`);
				}
				if (event.toolCall.type !== "toolCall") {
					throw new Error(`toolcall_end event has invalid tool call at index ${event.contentIndex}`);
				}
				this.endBlock(event.contentIndex, "toolCall");
				return {
					type: "toolcall_end",
					contentIndex: event.contentIndex,
					id: event.toolCall.id,
					name: event.toolCall.name,
					arguments: structuredClone(event.toolCall.arguments),
					...(event.toolCall.thoughtSignature === undefined
						? {}
						: { thoughtSignature: event.toolCall.thoughtSignature }),
					...(event.toolCall.namespace === undefined ? {} : { namespace: event.toolCall.namespace }),
				};
			}
		}
	}

	private startBlock(contentIndex: number, state: EncoderBlockState): void {
		assertContentIndex(contentIndex);
		if (this.blocks.has(contentIndex)) {
			throw new Error(`Assistant message block ${contentIndex} starts more than once`);
		}
		this.blocks.set(contentIndex, state);
	}

	private block(contentIndex: number, kind: EncoderBlockState["kind"]): EncoderBlockState {
		assertContentIndex(contentIndex);
		const state = this.blocks.get(contentIndex);
		if (state === undefined) throw new Error(`Assistant message ${kind} block ${contentIndex} has not started`);
		if (state.kind !== kind) {
			throw new Error(`Assistant message block ${contentIndex} is ${state.kind}, not ${kind}`);
		}
		return state;
	}

	private endBlock(contentIndex: number, kind: EncoderBlockState["kind"]): void {
		this.block(contentIndex, kind);
		this.blocks.delete(contentIndex);
	}

	private encodeTextDelta(
		contentIndex: number,
		delta: string,
		kind: "text" | "thinking",
	): AssistantMessageFrame | undefined {
		const state = this.block(contentIndex, kind);
		if (state.kind === "toolCall") throw new Error("Unreachable text encoder state");
		const deltaStart = state.deltaChars;
		state.deltaChars += delta.length;
		const covered = Math.max(0, state.coveredChars - deltaStart);
		if (covered >= delta.length) return undefined;
		const uncovered = covered === 0 ? delta : delta.slice(covered);
		return kind === "text"
			? { type: "text_delta", contentIndex, delta: uncovered }
			: { type: "thinking_delta", contentIndex, delta: uncovered };
	}
}

function appendBlock(
	message: AssistantMessage,
	states: Map<number, ReducerBlockState>,
	contentIndex: number,
	block: TextContent | ThinkingContent | ToolCall,
	state: ReducerBlockState,
): void {
	assertContentIndex(contentIndex);
	if (contentIndex !== message.content.length) {
		const reason = contentIndex < message.content.length ? "already exists" : "would leave a gap";
		throw new Error(`Cannot start assistant message block at index ${contentIndex}: ${reason}`);
	}
	message.content.push(structuredClone(block));
	states.set(contentIndex, state);
}

function activeBlock(
	message: AssistantMessage,
	states: Map<number, ReducerBlockState>,
	contentIndex: number,
	expectedKind: ReducerBlockState["kind"],
	frameType: AssistantMessageFrame["type"],
): { block: TextContent | ThinkingContent | ToolCall; state: ReducerBlockState } {
	assertContentIndex(contentIndex);
	const state = states.get(contentIndex);
	const block = message.content[contentIndex];
	if (!state || !block) {
		throw new Error(`${frameType} frame has no started block at index ${contentIndex}`);
	}
	if (state.kind !== expectedKind || block.type !== expectedKind) {
		throw new Error(
			`${frameType} frame expected ${expectedKind} block at index ${contentIndex}, found ${block.type}`,
		);
	}
	if (state.ended) {
		throw new Error(`${frameType} frame follows the end of block at index ${contentIndex}`);
	}
	return { block, state };
}

/**
 * Replay compact frames without mutating them. Returns `undefined` when the
 * iterable contains no start frame.
 */
export function reduceAssistantMessageFrames(frames: Iterable<AssistantMessageFrame>): AssistantMessage | undefined {
	let message: AssistantMessage | undefined;
	let frameBeforeStart: AssistantMessageFrame["type"] | undefined;
	const states = new Map<number, ReducerBlockState>();

	for (const frame of frames) {
		if (frame.type === "start") {
			if (message) throw new Error("Assistant message frame sequence contains more than one start frame");
			if (frameBeforeStart !== undefined)
				throw new Error(`${frameBeforeStart} frame appears before the start frame`);
			message = structuredClone(frame.partial);
			continue;
		}
		if (!message) {
			frameBeforeStart ??= frame.type;
			continue;
		}

		switch (frame.type) {
			case "text_start":
				if (frame.content.type !== "text") {
					throw new Error(`text_start frame contains ${frame.content.type} content`);
				}
				appendBlock(message, states, frame.contentIndex, frame.content, { kind: "text", ended: false });
				break;
			case "text_delta": {
				const { block } = activeBlock(message, states, frame.contentIndex, "text", frame.type);
				if (block.type !== "text") throw new Error("Unreachable text frame state");
				block.text += frame.delta;
				break;
			}
			case "text_end": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "text", frame.type);
				if (block.type !== "text") throw new Error("Unreachable text frame state");
				block.text = frame.content;
				delete block.textSignature;
				if (frame.textSignature !== undefined) block.textSignature = frame.textSignature;
				state.ended = true;
				break;
			}
			case "thinking_start":
				if (frame.content.type !== "thinking") {
					throw new Error(`thinking_start frame contains ${frame.content.type} content`);
				}
				appendBlock(message, states, frame.contentIndex, frame.content, {
					kind: "thinking",
					ended: false,
				});
				break;
			case "thinking_delta": {
				const { block } = activeBlock(message, states, frame.contentIndex, "thinking", frame.type);
				if (block.type !== "thinking") throw new Error("Unreachable thinking frame state");
				block.thinking += frame.delta;
				break;
			}
			case "thinking_end": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "thinking", frame.type);
				if (block.type !== "thinking") throw new Error("Unreachable thinking frame state");
				block.thinking = frame.content;
				delete block.thinkingSignature;
				delete block.redacted;
				if (frame.thinkingSignature !== undefined) block.thinkingSignature = frame.thinkingSignature;
				if (frame.redacted !== undefined) block.redacted = frame.redacted;
				state.ended = true;
				break;
			}
			case "toolcall_start":
				if (frame.toolCall.type !== "toolCall") {
					throw new Error(`toolcall_start frame contains ${frame.toolCall.type} content`);
				}
				appendBlock(message, states, frame.contentIndex, frame.toolCall, {
					kind: "toolCall",
					ended: false,
					json: "",
				});
				break;
			case "toolcall_checkpoint": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "toolCall", frame.type);
				if (block.type !== "toolCall" || state.kind !== "toolCall") {
					throw new Error("Unreachable tool-call checkpoint state");
				}
				state.json = frame.json;
				block.arguments = parseStreamingJson<ToolCall["arguments"]>(frame.json);
				break;
			}
			case "toolcall_delta": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "toolCall", frame.type);
				if (block.type !== "toolCall" || state.kind !== "toolCall") {
					throw new Error("Unreachable tool-call frame state");
				}
				state.json += frame.delta;
				break;
			}
			case "toolcall_end": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "toolCall", frame.type);
				if (block.type !== "toolCall") throw new Error("Unreachable tool-call frame state");
				block.id = frame.id;
				block.name = frame.name;
				block.arguments = structuredClone(frame.arguments);
				delete block.thoughtSignature;
				delete block.namespace;
				if (frame.thoughtSignature !== undefined) block.thoughtSignature = frame.thoughtSignature;
				if (frame.namespace !== undefined) block.namespace = frame.namespace;
				state.ended = true;
				break;
			}
		}
	}

	if (!message) return undefined;
	for (const [contentIndex, state] of states) {
		if (state.kind !== "toolCall" || state.ended || state.json.length === 0) continue;
		const block = message.content[contentIndex];
		if (block?.type !== "toolCall") throw new Error("Unreachable tool-call frame state");
		block.arguments = parseStreamingJson<ToolCall["arguments"]>(state.json);
	}

	return message;
}
