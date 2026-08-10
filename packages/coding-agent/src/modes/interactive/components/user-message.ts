import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import type { MarkdownMessageMeta, MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageMeta: MarkdownMessageMeta = {};
	/** Per-render-session identity for pre-persistence frames; NOT the session entry id. */
	private transientId = randomUUID();

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageMeta: MarkdownMessageMeta = {},
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageMeta = messageMeta;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	/**
	 * Attach the persisted session-entry identity once the entry exists
	 * (live messages render before persistence). Rebuilds the markdown.
	 */
	setMessageMeta(meta: MarkdownMessageMeta): void {
		this.messageMeta = { ...this.messageMeta, ...meta };
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		contentBox.addChild(
			new Markdown(
				this.text,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, this.markdownTransformers, {
						...this.messageMeta,
						transientId: this.transientId,
					}),
				},
			),
		);
		this.addChild(contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
