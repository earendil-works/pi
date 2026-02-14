import type { AssistantMessage, AssistantMessageEvent } from "@kennyfrc/mu-ai";
import { Container, Spacer, Text } from "@kennyfrc/mu-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";

export interface StreamingAssistantMessageOptions {
	/**
	 * Maximum number of characters to keep in memory for each streamed block type.
	 * This bounds both memory and the cost of wrapping/rendering.
	 */
	maxBufferChars?: number;
}

const DEFAULT_MAX_BUFFER_CHARS = 64 * 1024;

/**
 * Streaming assistant message component.
 *
 * During token streaming, we keep a bounded rolling buffer and render via cheap
 * `Text` blocks (no markdown parsing). Once the message ends, we swap the inner
 * rendering to the full `AssistantMessageComponent` (Markdown).
 */
export class StreamingAssistantMessageComponent extends Container {
	private revision = 0;
	private maxBufferChars: number;

	private textBuffer = "";
	private thinkingBuffer = "";

	private streamingContainer: Container;
	private leadingSpacer: Spacer;
	private betweenSpacer: Spacer;
	private thinkingText: Text;
	private responseText: Text;

	private mode: "streaming" | "final" = "streaming";

	getRevision(): number {
		return this.revision;
	}

	override invalidate(): void {
		super.invalidate();
		// Theme changes should restyle any pre-styled streaming buffers immediately,
		// even if no further deltas arrive.
		if (this.mode === "streaming") {
			this.updateStreamingDisplay();
		} else {
			this.revision++;
		}
	}

	constructor(options: StreamingAssistantMessageOptions = {}) {
		super();
		this.maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;

		this.streamingContainer = new Container();
		this.leadingSpacer = new Spacer(0);
		this.betweenSpacer = new Spacer(0);
		this.thinkingText = new Text("", 1, 0);
		this.responseText = new Text("", 1, 0);

		this.streamingContainer.addChild(this.leadingSpacer);
		this.streamingContainer.addChild(this.thinkingText);
		this.streamingContainer.addChild(this.betweenSpacer);
		this.streamingContainer.addChild(this.responseText);

		this.addChild(this.streamingContainer);
	}

	resetFromMessage(message: AssistantMessage): void {
		this.mode = "streaming";
		this.clear();
		this.addChild(this.streamingContainer);

		this.textBuffer = "";
		this.thinkingBuffer = "";

		// Seed from any already-present content (usually empty at message_start).
		for (const c of message.content) {
			if (c.type === "text") {
				this.textBuffer = this.appendRolling(this.textBuffer, c.text);
			}
			if (c.type === "thinking") {
				this.thinkingBuffer = this.appendRolling(this.thinkingBuffer, c.thinking);
			}
		}

		this.updateStreamingDisplay();
	}

	applyAssistantMessageEvent(event: AssistantMessageEvent): void {
		if (this.mode !== "streaming") return;

		switch (event.type) {
			case "start":
				this.textBuffer = "";
				this.thinkingBuffer = "";
				this.updateStreamingDisplay();
				return;

			case "text_delta":
				this.textBuffer = this.appendRolling(this.textBuffer, event.delta);
				this.updateStreamingDisplay();
				return;

			case "thinking_delta":
				this.thinkingBuffer = this.appendRolling(this.thinkingBuffer, event.delta);
				this.updateStreamingDisplay();
				return;

			case "text_end":
				// Some providers may emit a final content snapshot; prefer it to avoid
				// any missing trailing deltas.
				this.textBuffer = this.appendRolling("", event.content);
				this.updateStreamingDisplay();
				return;

			case "thinking_end":
				this.thinkingBuffer = this.appendRolling("", event.content);
				this.updateStreamingDisplay();
				return;

			default:
				// tool calls, done, error, etc. don't affect streaming text display.
				return;
		}
	}

	finalize(message: AssistantMessage): void {
		this.mode = "final";
		this.clear();
		this.addChild(new AssistantMessageComponent(message));
		this.revision++;
	}

	private updateStreamingDisplay(): void {
		this.revision++;

		const hasThinking = this.thinkingBuffer.trim().length > 0;
		const hasText = this.textBuffer.trim().length > 0;
		const hasAny = hasThinking || hasText;

		this.leadingSpacer.setLines(hasAny ? 1 : 0);
		this.betweenSpacer.setLines(hasThinking && hasText ? 1 : 0);

		this.thinkingText.setText(hasThinking ? theme.fg("muted", this.thinkingBuffer) : "");
		this.responseText.setText(hasText ? this.textBuffer : "");
	}

	private appendRolling(current: string, chunk: string): string {
		if (!chunk) return current;
		let next = current + chunk;
		if (next.length <= this.maxBufferChars) return next;

		const trimStart = next.length - this.maxBufferChars;
		const newlineIdx = next.indexOf("\n", trimStart);
		const cutPoint = newlineIdx !== -1 && newlineIdx < trimStart + 1000 ? newlineIdx + 1 : trimStart;
		next = next.slice(cutPoint);
		return next;
	}
}
