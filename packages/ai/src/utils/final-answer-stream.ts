/**
 * Streaming transform that promotes <final_answer> marker text into structured finalAnswer blocks.
 */

import type { AssistantMessage, AssistantMessageEvent, FinalAnswerContent, TextContent } from "../types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";

const OPEN_MARKER = "<final_answer>";
const CLOSE_MARKER = "</final_answer>";

type TextBlockState = {
	index: number;
	text: string;
	open: boolean;
};

type FinalAnswerBlockState = {
	index: number;
	text: string;
	open: boolean;
};

type ForwardedContentEvent = Extract<AssistantMessageEvent, { contentIndex: number; partial: AssistantMessage }>;

function cloneContentBlock(block: AssistantMessage["content"][number]): AssistantMessage["content"][number] {
	if (block.type === "toolCall") {
		return { ...block, arguments: { ...block.arguments } };
	}
	return { ...block };
}

function cloneMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map(cloneContentBlock),
		usage: { ...message.usage, cost: { ...message.usage.cost } },
		diagnostics: message.diagnostics ? [...message.diagnostics] : undefined,
	};
}

function markerPrefixLength(text: string, marker: string): number {
	const max = Math.min(text.length, marker.length - 1);
	for (let length = max; length > 0; length--) {
		if (marker.startsWith(text.slice(text.length - length))) {
			return length;
		}
	}
	return 0;
}

class FinalAnswerParser {
	private partial: AssistantMessage | undefined;
	private textBlock: TextBlockState | undefined;
	private finalAnswerBlock: FinalAnswerBlockState | undefined;
	private buffer = "";
	private insideFinalAnswer = false;
	private seenFinalAnswer = false;
	private pendingEvents: AssistantMessageEvent[] = [];
	private forwardedContentIndexes = new Map<number, number>();
	private readonly target: AssistantMessageEventStream;

	constructor(target: AssistantMessageEventStream) {
		this.target = target;
	}

	handle(event: AssistantMessageEvent): void {
		switch (event.type) {
			case "start":
				this.partial = { ...cloneMessage(event.partial), content: [] };
				this.target.push({ type: "start", partial: this.snapshot() });
				return;
			case "text_start":
				this.ensurePartial(event.partial);
				return;
			case "text_delta":
				this.ensurePartial(event.partial);
				this.processText(event.delta, false);
				this.flushPendingEvents();
				return;
			case "text_end":
				this.ensurePartial(event.partial);
				this.processText("", true);
				this.endTextBlock();
				this.flushPendingEvents();
				return;
			case "final_answer_start":
			case "final_answer_delta":
			case "final_answer_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				this.forwardNonTextEvent(event);
				return;
			case "done":
				this.ensurePartial(event.message);
				this.finalizeOpenBlocks(true);
				this.flushPendingEvents();
				this.target.push({ type: "done", reason: event.reason, message: this.snapshot() });
				return;
			case "error":
				this.ensurePartial(event.error);
				this.finalizeOpenBlocks(false);
				this.flushPendingEvents();
				this.target.push({ type: "error", reason: event.reason, error: this.snapshot() });
				return;
		}
	}

	private ensurePartial(message: AssistantMessage): void {
		if (!this.partial) {
			this.partial = { ...cloneMessage(message), content: [] };
			return;
		}
		this.partial = { ...this.partial, ...message, content: this.partial.content };
	}

	private snapshot(): AssistantMessage {
		if (!this.partial) {
			throw new Error("Final answer parser has no assistant message");
		}
		return cloneMessage(this.partial);
	}

	private nextContentIndex(): number {
		if (!this.partial) {
			throw new Error("Final answer parser has no assistant message");
		}
		return this.partial.content.length;
	}

	private startTextBlock(): void {
		if (this.textBlock?.open) {
			return;
		}
		const block: TextContent = { type: "text", text: "" };
		const index = this.nextContentIndex();
		this.partial!.content.push(block);
		this.textBlock = { index, text: "", open: true };
		this.pendingEvents.push({ type: "text_start", contentIndex: index, partial: this.snapshot() });
	}

	private emitText(text: string): void {
		if (text.length === 0) return;
		this.startTextBlock();
		const block = this.partial!.content[this.textBlock!.index];
		if (block?.type !== "text") {
			throw new Error("Final answer parser text block index is not text");
		}
		block.text += text;
		this.textBlock!.text += text;
		this.pendingEvents.push({
			type: "text_delta",
			contentIndex: this.textBlock!.index,
			delta: text,
			partial: this.snapshot(),
		});
	}

	private endTextBlock(): void {
		if (!this.textBlock?.open) return;
		this.textBlock.open = false;
		this.pendingEvents.push({
			type: "text_end",
			contentIndex: this.textBlock.index,
			content: this.textBlock.text,
			partial: this.snapshot(),
		});
	}

	private startFinalAnswerBlock(): void {
		if (this.finalAnswerBlock?.open) return;
		this.endTextBlock();
		const block: FinalAnswerContent = { type: "finalAnswer", text: "" };
		const index = this.nextContentIndex();
		this.partial!.content.push(block);
		this.finalAnswerBlock = { index, text: "", open: true };
		this.seenFinalAnswer = true;
		this.pendingEvents.push({ type: "final_answer_start", contentIndex: index, partial: this.snapshot() });
	}

	private emitFinalAnswer(text: string): void {
		if (text.length === 0) return;
		this.startFinalAnswerBlock();
		const block = this.partial!.content[this.finalAnswerBlock!.index];
		if (block?.type !== "finalAnswer") {
			throw new Error("Final answer parser finalAnswer block index is not finalAnswer");
		}
		block.text += text;
		this.finalAnswerBlock!.text += text;
		this.pendingEvents.push({
			type: "final_answer_delta",
			contentIndex: this.finalAnswerBlock!.index,
			delta: text,
			partial: this.snapshot(),
		});
	}

	private endFinalAnswerBlock(): void {
		if (!this.finalAnswerBlock?.open) return;
		this.finalAnswerBlock.open = false;
		this.insideFinalAnswer = false;
		this.pendingEvents.push({
			type: "final_answer_end",
			contentIndex: this.finalAnswerBlock.index,
			content: this.finalAnswerBlock.text,
			partial: this.snapshot(),
		});
	}

	private processText(delta: string, flush: boolean): void {
		this.buffer += delta;
		while (this.buffer.length > 0) {
			if (!this.insideFinalAnswer) {
				if (this.seenFinalAnswer) {
					const text = this.buffer;
					this.buffer = "";
					this.emitText(text);
					continue;
				}
				const markerIndex = this.buffer.indexOf(OPEN_MARKER);
				if (markerIndex >= 0) {
					this.emitText(this.buffer.slice(0, markerIndex));
					this.buffer = this.buffer.slice(markerIndex + OPEN_MARKER.length);
					this.insideFinalAnswer = true;
					this.startFinalAnswerBlock();
					continue;
				}
				const keep = flush ? 0 : markerPrefixLength(this.buffer, OPEN_MARKER);
				const text = this.buffer.slice(0, this.buffer.length - keep);
				this.buffer = this.buffer.slice(this.buffer.length - keep);
				this.emitText(text);
				break;
			}

			const markerIndex = this.buffer.indexOf(CLOSE_MARKER);
			if (markerIndex >= 0) {
				this.emitFinalAnswer(this.buffer.slice(0, markerIndex));
				this.buffer = this.buffer.slice(markerIndex + CLOSE_MARKER.length);
				this.endFinalAnswerBlock();
				continue;
			}
			const keep = flush ? 0 : markerPrefixLength(this.buffer, CLOSE_MARKER);
			const text = this.buffer.slice(0, this.buffer.length - keep);
			this.buffer = this.buffer.slice(this.buffer.length - keep);
			this.emitFinalAnswer(text);
			break;
		}
	}

	private finalizeOpenBlocks(emitEndEvents: boolean): void {
		this.processText("", true);
		if (emitEndEvents) {
			this.endTextBlock();
			this.endFinalAnswerBlock();
		}
	}

	private forwardNonTextEvent(event: ForwardedContentEvent): void {
		if (event.type === "final_answer_start" || event.type === "thinking_start" || event.type === "toolcall_start") {
			this.endTextBlock();
		}
		const partial = "partial" in event ? event.partial : undefined;
		if (!partial) {
			this.target.push(event);
			return;
		}

		this.ensurePartial(partial);
		const sourceBlock = partial.content[event.contentIndex];
		if (!sourceBlock) {
			this.target.push(event);
			return;
		}

		const existingIndex = this.forwardedContentIndexes.get(event.contentIndex);
		const index = existingIndex ?? this.nextContentIndex();
		this.forwardedContentIndexes.set(event.contentIndex, index);
		this.partial!.content[index] = cloneContentBlock(sourceBlock);
		this.target.push({ ...event, contentIndex: index, partial: this.snapshot() } as AssistantMessageEvent);
	}

	private flushPendingEvents(): void {
		for (const event of this.pendingEvents) {
			this.target.push(event);
		}
		this.pendingEvents = [];
	}
}

export function parseFinalAnswerMarkers(source: AsyncIterable<AssistantMessageEvent>): AssistantMessageEventStream {
	const target = new AssistantMessageEventStream();
	const parser = new FinalAnswerParser(target);
	void (async () => {
		for await (const event of source) {
			parser.handle(event);
		}
	})();
	return target;
}
