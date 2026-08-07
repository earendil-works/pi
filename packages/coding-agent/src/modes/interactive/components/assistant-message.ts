import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;

	// Text/thinking components created by the last content build, in content
	// order. During streaming, message_update events arrive per chunk; when the
	// run structure is unchanged the Markdown components are updated in place via
	// setText() instead of being destroyed and recreated, so their append-aware
	// render cache re-renders only the tail that grew.
	private streamingEditable: Array<{ kind: "text" | "thinking"; component: Markdown | Text }> = [];

	/** Read-only view for tests: components created by the last content build. */
	get streamingEditableComponents(): ReadonlyArray<{ kind: "text" | "thinking"; component: Markdown | Text }> {
		return this.streamingEditable;
	}

	private builtWithTheme?: MarkdownTheme;
	private builtWithOutputPad = 0;
	private builtWithHideThinkingBlock = false;
	private builtWithHiddenThinkingLabel = "";
	private builtWithTransformers: readonly MarkdownTransformer[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		const previousMessage = this.lastMessage;
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Fast path: during streaming the content usually just grows. If the
		// sequence of text/thinking runs is unchanged and nothing that affects the
		// components' construction (theme, padding, ...) changed, update the
		// existing Markdown components in place so their append-aware render cache
		// stays warm.
		if (
			isStreaming &&
			previousMessage !== undefined &&
			previousMessage.stopReason === message.stopReason &&
			previousMessage.errorMessage === message.errorMessage &&
			this.tryUpdateStreamingInPlace(previousMessage, message)
		) {
			this.hasToolCalls = message.content.some((c) => c.type === "toolCall");
			return;
		}
		this.streamingEditable = [];

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		const editable: Array<{ kind: "text" | "thinking"; component: Markdown | Text }> = [];
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const component = new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
					transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					streaming: this.isStreaming,
				});
				this.contentContainer.addChild(component);
				editable.push({ kind: "text", component });
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					const component = new Text(
						theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)),
						this.outputPad,
						0,
					);
					this.contentContainer.addChild(component);
					editable.push({ kind: "thinking", component });
				} else {
					// Render each run of thinking blocks as one Markdown section.
					const component = new Markdown(
						thinkingBlocks.join("\n\n"),
						this.outputPad,
						0,
						this.markdownTheme,
						{
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						},
						{
							transform: createMarkdownTransform(
								"assistant-thinking",
								this.isStreaming,
								this.markdownTransformers,
							),
							streaming: this.isStreaming,
						},
					);
					this.contentContainer.addChild(component);
					editable.push({ kind: "thinking", component });
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}
		this.streamingEditable = editable;
		this.builtWithTheme = this.markdownTheme;
		this.builtWithOutputPad = this.outputPad;
		this.builtWithHideThinkingBlock = this.hideThinkingBlock;
		this.builtWithHiddenThinkingLabel = this.hiddenThinkingLabel;
		this.builtWithTransformers = this.markdownTransformers;

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}

	/**
	 * Streaming fast path: when the sequence of visible text/thinking runs is
	 * unchanged between two consecutive message_update events, update the existing
	 * Markdown components in place via setText() instead of rebuilding them. This
	 * keeps the components' append-aware render cache warm, so each chunk only
	 * re-renders the appended tail instead of re-parsing the whole message.
	 */
	private tryUpdateStreamingInPlace(previous: AssistantMessage, message: AssistantMessage): boolean {
		// Rebuild if anything that affects component construction changed.
		if (
			this.markdownTheme !== this.builtWithTheme ||
			this.outputPad !== this.builtWithOutputPad ||
			this.hideThinkingBlock !== this.builtWithHideThinkingBlock ||
			this.hiddenThinkingLabel !== this.builtWithHiddenThinkingLabel ||
			this.markdownTransformers !== this.builtWithTransformers
		) {
			return false;
		}
		if (this.streamingEditable.length === 0) return false;

		const extractRuns = (msg: AssistantMessage): Array<{ kind: "text" | "thinking"; text: string }> => {
			const runs: Array<{ kind: "text" | "thinking"; text: string }> = [];
			for (let i = 0; i < msg.content.length; i++) {
				const content = msg.content[i];
				if (content.type === "text") {
					if (content.text.trim()) runs.push({ kind: "text", text: content.text });
				} else if (content.type === "thinking") {
					const thinkingBlocks: string[] = [];
					for (; i < msg.content.length; i++) {
						const thinkingContent = msg.content[i];
						if (thinkingContent.type !== "thinking") break;
						if (thinkingContent.thinking.trim()) thinkingBlocks.push(thinkingContent.thinking);
					}
					i--;
					if (thinkingBlocks.length === 0) continue;
					runs.push({ kind: "thinking", text: thinkingBlocks.join("\n\n") });
				}
			}
			return runs;
		};

		const prevRuns = extractRuns(previous);
		const nextRuns = extractRuns(message);
		if (prevRuns.length === 0 || prevRuns.length !== nextRuns.length) return false;
		for (let i = 0; i < prevRuns.length; i++) {
			if (prevRuns[i]!.kind !== nextRuns[i]!.kind) return false;
			const component = this.streamingEditable[i]?.component;
			if (!component || !("setText" in component)) return false;
		}

		for (let i = 0; i < nextRuns.length; i++) {
			const editable = this.streamingEditable[i]!;
			(editable.component as Markdown | Text).setText(nextRuns[i]!.text);
		}
		return true;
	}
}
