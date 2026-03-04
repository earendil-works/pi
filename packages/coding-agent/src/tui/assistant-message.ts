import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { Container, Markdown, Spacer, Text } from "@kennyfrc/mu-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { fixThinkingSpill, normalizeExcessiveWhitespace, normalizePunctuationSpacing } from "./thinking-spill.js";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private revision = 0;
	private contentContainer: Container;
	private cachedBlockTypes: Array<"text" | "thinking"> = [];
	private cachedHasLeadingSpacer = false;
	private cachedStatusKind: "none" | "aborted" | "error" = "none";
	private cachedStatusMessage: string | null = null;
	private cachedHasToolCalls = false;
	private cachedMarkdownBlocks: Markdown[] = [];

	getRevision(): number {
		return this.revision;
	}

	constructor(message?: AssistantMessage) {
		super();

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	updateContent(message: AssistantMessage): void {
		this.revision++;

		// Render thinking blocks before response text blocks to keep the UI stable
		// between streaming (which is always thinking→text) and the finalized render.
		const thinkingBlocks: Array<{ type: "thinking"; text: string }> = [];
		const textBlocks: Array<{ type: "text"; text: string }> = [];
		for (const content of message.content) {
			if (content.type === "text") {
				const text = content.text.trim();
				if (text) textBlocks.push({ type: "text", text });
			} else if (content.type === "thinking") {
				const thinking = content.thinking.trim();
				if (thinking) thinkingBlocks.push({ type: "thinking", text: thinking });
			}
		}

		// Guard against providers/models that duplicate thinking into the response text.
		//
		// We intentionally compare against the *combined* thinking trace, so we can
		// detect spill even if the final message block order is [text, thinking].
		const combinedThinking = thinkingBlocks
			.map((b) => b.text)
			.join("\n\n")
			.trim();
		if (combinedThinking.length > 0) {
			for (const block of textBlocks) {
				const fixed = fixThinkingSpill(combinedThinking, block.text, {
					// Prefer keeping the thinking trace inside the thinking block.
					exactDuplicateStrategy: "dropText",
				});
				block.text = fixed.text.trim();
			}
		}

		const blocks: Array<{ type: "text" | "thinking"; text: string }> = [
			...thinkingBlocks.map((b) => ({ ...b, text: normalizeExcessiveWhitespace(b.text) })),
			...textBlocks
				.filter((b) => b.text.trim().length > 0)
				.map((b) => ({
					...b,
					text: normalizePunctuationSpacing(normalizeExcessiveWhitespace(b.text)),
				})),
		];

		const hasLeadingSpacer = blocks.length > 0;
		const blockTypes = blocks.map((b) => b.type);
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		let statusKind: "none" | "aborted" | "error" = "none";
		let statusMessage: string | null = null;

		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				statusKind = "aborted";
			} else if (message.stopReason === "error") {
				statusKind = "error";
				statusMessage = message.errorMessage || "Unknown error";
			}
		}

		const canReuse =
			this.cachedMarkdownBlocks.length === blocks.length &&
			this.cachedHasLeadingSpacer === hasLeadingSpacer &&
			this.cachedHasToolCalls === hasToolCalls &&
			this.cachedStatusKind === statusKind &&
			this.cachedStatusMessage === statusMessage &&
			this.cachedBlockTypes.length === blockTypes.length &&
			this.cachedBlockTypes.every((t, i) => t === blockTypes[i]);

		if (canReuse) {
			for (let i = 0; i < blocks.length; i++) {
				this.cachedMarkdownBlocks[i]?.setText(blocks[i]!.text);
			}
			return;
		}

		// Block signature changed (or first render) - rebuild component tree.
		this.contentContainer.clear();
		this.cachedMarkdownBlocks = [];

		this.cachedBlockTypes = blockTypes;
		this.cachedHasLeadingSpacer = hasLeadingSpacer;
		this.cachedHasToolCalls = hasToolCalls;
		this.cachedStatusKind = statusKind;
		this.cachedStatusMessage = statusMessage;

		if (hasLeadingSpacer) {
			this.contentContainer.addChild(new Spacer(1));
		}

		for (const block of blocks) {
			if (block.type === "text") {
				const md = new Markdown(block.text, 1, 0, getMarkdownTheme(), undefined, { renderHtml: true });
				this.cachedMarkdownBlocks.push(md);
				this.contentContainer.addChild(md);
				continue;
			}

			const md = new Markdown(
				block.text,
				1,
				0,
				getMarkdownTheme(),
				{
					color: (text: string) => theme.fg("muted", text),
					italic: true,
				},
				{ renderHtml: true },
			);
			this.cachedMarkdownBlocks.push(md);
			this.contentContainer.addChild(md);
			this.contentContainer.addChild(new Spacer(1));
		}

		if (statusKind === "aborted") {
			this.contentContainer.addChild(new Text(theme.fg("error", "\nAborted"), 1, 0));
		} else if (statusKind === "error") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${statusMessage}`), 1, 0));
		}
	}
}
