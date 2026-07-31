/**
 * Streaming transform that promotes configured XML marker text into structured assistant blocks.
 */

import type { AssistantBlockContent, AssistantMessage, AssistantMessageEvent, TextContent } from "../types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";

export interface AssistantBlockDefinition {
	name: string;
	tag: string;
}

export const FINAL_ANSWER_BLOCK_NAME = "final_answer";
export const DEFAULT_ASSISTANT_BLOCKS: readonly AssistantBlockDefinition[] = [
	{ name: FINAL_ANSWER_BLOCK_NAME, tag: "final_answer" },
];

type TextBlockState = {
	index: number;
	text: string;
	open: boolean;
};

type AssistantBlockState = {
	index: number;
	name: string;
	text: string;
	open: boolean;
};

type Marker = {
	definition: AssistantBlockDefinition;
	open: string;
	close: string;
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

function markerPrefixLength(text: string, markers: readonly string[]): number {
	let best = 0;
	for (const marker of markers) {
		const max = Math.min(text.length, marker.length - 1);
		for (let length = max; length > best; length--) {
			if (marker.startsWith(text.slice(text.length - length))) {
				best = length;
				break;
			}
		}
	}
	return best;
}

function findFirstMarker(text: string, markers: readonly Marker[]): { marker: Marker; index: number } | undefined {
	let match: { marker: Marker; index: number } | undefined;
	for (const marker of markers) {
		const index = text.indexOf(marker.open);
		if (index >= 0 && (!match || index < match.index)) {
			match = { marker, index };
		}
	}
	return match;
}

function normalizeDefinitions(definitions: readonly AssistantBlockDefinition[] | undefined): Marker[] {
	const values = definitions ?? DEFAULT_ASSISTANT_BLOCKS;
	return values.map((definition) => {
		if (!definition.name.trim()) throw new Error("Assistant block name must not be empty");
		if (!definition.tag.trim()) throw new Error(`Assistant block tag for ${definition.name} must not be empty`);
		if (definition.tag.includes("<") || definition.tag.includes(">") || definition.tag.includes("/")) {
			throw new Error(`Assistant block tag for ${definition.name} must be a bare XML tag name`);
		}
		return { definition, open: `<${definition.tag}>`, close: `</${definition.tag}>` };
	});
}

class AssistantBlockParser {
	private partial: AssistantMessage | undefined;
	private textBlock: TextBlockState | undefined;
	private assistantBlock: AssistantBlockState | undefined;
	private buffer = "";
	private activeMarker: Marker | undefined;
	private seenBlock = false;
	private pendingEvents: AssistantMessageEvent[] = [];
	private forwardedContentIndexes = new Map<number, number>();
	private readonly target: AssistantMessageEventStream;
	private readonly markers: readonly Marker[];
	private readonly openMarkers: readonly string[];

	constructor(target: AssistantMessageEventStream, definitions?: readonly AssistantBlockDefinition[]) {
		this.target = target;
		this.markers = normalizeDefinitions(definitions);
		this.openMarkers = this.markers.map((marker) => marker.open);
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
			case "block_start":
			case "block_delta":
			case "block_end":
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
		if (!this.partial) throw new Error("Assistant block parser has no assistant message");
		return cloneMessage(this.partial);
	}

	private nextContentIndex(): number {
		if (!this.partial) throw new Error("Assistant block parser has no assistant message");
		return this.partial.content.length;
	}

	private startTextBlock(): void {
		if (this.textBlock?.open) return;
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
		if (block?.type !== "text") throw new Error("Assistant block parser text block index is not text");
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

	private startAssistantBlock(marker: Marker): void {
		if (this.assistantBlock?.open) return;
		this.endTextBlock();
		const block: AssistantBlockContent = { type: "block", name: marker.definition.name, text: "" };
		const index = this.nextContentIndex();
		this.partial!.content.push(block);
		this.assistantBlock = { index, name: marker.definition.name, text: "", open: true };
		this.seenBlock = true;
		this.pendingEvents.push({
			type: "block_start",
			name: marker.definition.name,
			contentIndex: index,
			partial: this.snapshot(),
		});
	}

	private emitAssistantBlock(text: string): void {
		if (text.length === 0) return;
		if (!this.activeMarker) throw new Error("Assistant block parser has no active marker");
		this.startAssistantBlock(this.activeMarker);
		const block = this.partial!.content[this.assistantBlock!.index];
		if (block?.type !== "block") throw new Error("Assistant block parser block index is not block");
		block.text += text;
		this.assistantBlock!.text += text;
		this.pendingEvents.push({
			type: "block_delta",
			name: this.assistantBlock!.name,
			contentIndex: this.assistantBlock!.index,
			delta: text,
			partial: this.snapshot(),
		});
	}

	private endAssistantBlock(): void {
		if (!this.assistantBlock?.open) return;
		this.assistantBlock.open = false;
		this.pendingEvents.push({
			type: "block_end",
			name: this.assistantBlock.name,
			contentIndex: this.assistantBlock.index,
			content: this.assistantBlock.text,
			partial: this.snapshot(),
		});
		this.assistantBlock = undefined;
		this.activeMarker = undefined;
	}

	private processText(delta: string, flush: boolean): void {
		this.buffer += delta;
		while (this.buffer.length > 0) {
			if (!this.activeMarker) {
				if (this.seenBlock) {
					const text = this.buffer;
					this.buffer = "";
					this.emitText(text);
					continue;
				}
				const match = findFirstMarker(this.buffer, this.markers);
				if (match) {
					this.emitText(this.buffer.slice(0, match.index));
					this.buffer = this.buffer.slice(match.index + match.marker.open.length);
					this.activeMarker = match.marker;
					this.startAssistantBlock(match.marker);
					continue;
				}
				const keep = flush ? 0 : markerPrefixLength(this.buffer, this.openMarkers);
				const text = this.buffer.slice(0, this.buffer.length - keep);
				this.buffer = this.buffer.slice(this.buffer.length - keep);
				this.emitText(text);
				break;
			}

			const markerIndex = this.buffer.indexOf(this.activeMarker.close);
			if (markerIndex >= 0) {
				this.emitAssistantBlock(this.buffer.slice(0, markerIndex));
				this.buffer = this.buffer.slice(markerIndex + this.activeMarker.close.length);
				this.endAssistantBlock();
				continue;
			}
			const keep = flush ? 0 : markerPrefixLength(this.buffer, [this.activeMarker.close]);
			const text = this.buffer.slice(0, this.buffer.length - keep);
			this.buffer = this.buffer.slice(this.buffer.length - keep);
			this.emitAssistantBlock(text);
			break;
		}
	}

	private finalizeOpenBlocks(emitEndEvents: boolean): void {
		this.processText("", true);
		if (emitEndEvents) {
			this.endTextBlock();
			this.endAssistantBlock();
		}
	}

	private forwardNonTextEvent(event: ForwardedContentEvent): void {
		if (event.type === "block_start" || event.type === "thinking_start" || event.type === "toolcall_start")
			this.endTextBlock();
		this.ensurePartial(event.partial);
		const sourceBlock = event.partial.content[event.contentIndex];
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
		for (const event of this.pendingEvents) this.target.push(event);
		this.pendingEvents = [];
	}
}

export function parseAssistantBlockMarkers(
	source: AsyncIterable<AssistantMessageEvent>,
	definitions?: readonly AssistantBlockDefinition[],
): AssistantMessageEventStream {
	const target = new AssistantMessageEventStream();
	const parser = new AssistantBlockParser(target, definitions);
	void (async () => {
		for await (const event of source) parser.handle(event);
	})();
	return target;
}

export function parseFinalAnswerMarkers(source: AsyncIterable<AssistantMessageEvent>): AssistantMessageEventStream {
	return parseAssistantBlockMarkers(source, DEFAULT_ASSISTANT_BLOCKS);
}
