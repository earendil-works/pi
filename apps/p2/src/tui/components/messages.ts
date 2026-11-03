// Copied from coding-agent interactive/components/{user-message,assistant-message,compaction-summary-message}.ts with
// the instance theme (section 5.4) and sanitized server text. p2 additions to the user message (section 1.3): author
// label with the guest "unverified name" note, peer attribution, reply quote, plugin note, files and image count.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Box, Container, Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { TuiSettings } from "../../runtime/tui-preferences.ts";
import { createMarkdownTransform, type MarkdownTransformer } from "../../runtime/tui-renderers.ts";
import type { Item } from "../../web/transcript.ts";
import { lineText, type RenderContext, safeText } from "../render-context.ts";
import { parseSkillBlock, SkillInvocationComponent } from "./skill-invocation.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export type MessageContext = RenderContext & {
	readonly markdownTransformers: readonly MarkdownTransformer[];
	/** The visitor's settings (Markdown transformers read e.g. `markdown.mermaid`). */
	readonly settings?: TuiSettings;
	readonly outputPad?: number;
};
type UserItem = Extract<Item, { type: "user" }>;

/** OSC 133 prompt zones: pi-tui uses them for prompt jumps and strips them from screen lines. */
function zone(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	lines[0] = OSC133_ZONE_START + lines[0];
	lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
	return lines;
}

/** Rebuilds baked content when the theme changed (section 5.4). */
abstract class Themed extends Container {
	protected readonly ctx: MessageContext;
	private themeVersion: number;
	constructor(ctx: MessageContext) {
		super();
		this.ctx = ctx;
		this.themeVersion = ctx.theme.version;
	}
	protected abstract rebuild(): void;
	override render(width: number): string[] {
		if (this.themeVersion !== this.ctx.theme.version) {
			this.themeVersion = this.ctx.theme.version;
			this.rebuild();
		}
		return super.render(width);
	}
}

export class UserMessageComponent extends Themed {
	private item: UserItem;
	/** A `/skill:` invocation (10.8): pi's collapsible skill block, then the user's own text. */
	private skill: SkillInvocationComponent | undefined;
	private expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.skill?.setExpanded(expanded);
	}
	constructor(item: UserItem, ctx: MessageContext) {
		super(ctx);
		this.item = item;
		this.rebuild();
	}
	update(item: UserItem): void {
		if (item === this.item) return;
		this.item = item;
		this.rebuild();
	}
	protected rebuild(): void {
		this.clear();
		const theme = this.ctx.theme.current;
		const pad = this.ctx.outputPad ?? 1;
		const block = parseSkillBlock(this.item.text);
		this.skill = undefined;
		if (block) {
			this.skill = new SkillInvocationComponent(block, this.ctx, pad);
			this.skill.setExpanded(this.expanded);
			this.addChild(this.skill);
		}
		const item = block ? { ...this.item, text: block.userMessage ?? "" } : this.item;
		// Nothing of the user's own besides the skill: the block alone, as pi.
		if (block && !item.text && !item.files.length && !item.images.length) return;
		const bg = (text: string) => theme.bg("userMessageBg", text);
		const markdown = (paddingY: number) =>
			new Markdown(
				safeText(item.text),
				paddingY ? pad : 0,
				paddingY,
				this.ctx.theme.markdown,
				{ color: (content: string) => theme.fg("userMessageText", content), bgColor: bg },
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, this.ctx.markdownTransformers, this.ctx),
				},
			);
		const head: string[] = [];
		const name = item.author?.name ?? item.peer?.title;
		// Guests, peers and chat-mode messages are labeled; the owner's own inputs look like pi's.
		if (name && (item.author?.kind === "guest" || item.peer || item.chat)) {
			const label = theme.fg("accent", theme.bold(lineText(name)));
			const note = item.author?.kind === "guest" ? theme.fg("muted", " (guest, unverified name)") : "";
			head.push(`${label}${note}${item.peer ? theme.fg("muted", " · from another session") : ""}`);
		}
		if (item.replyTo)
			head.push(theme.fg("muted", `↪ ${lineText(item.replyTo.name)}: ${lineText(item.replyTo.excerpt)}`));
		if (item.note) head.push(theme.fg("muted", lineText(item.note)));
		const tail = [
			...item.files.map((file) => theme.fg("muted", `[file] ${lineText(file)}`)),
			...(item.images.length
				? [theme.fg("muted", `[${item.images.length} image${item.images.length === 1 ? "" : "s"}]`)]
				: []),
		];
		if (head.length === 0 && tail.length === 0) {
			// The Markdown pads and colors its own background, as pi's.
			this.addChild(markdown(1));
			return;
		}
		const box = new Box(pad, 1, bg);
		if (head.length) box.addChild(new Text(head.join("\n"), 0, 0));
		if (item.text.trim()) box.addChild(markdown(0));
		if (tail.length) box.addChild(new Text(tail.join("\n"), 0, 0));
		this.addChild(box);
	}
	override render(width: number): string[] {
		return zone(super.render(width));
	}
}

export class AssistantMessageComponent extends Themed {
	private contentContainer = new Container();
	private hideThinkingBlock: boolean;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();

	constructor(
		ctx: MessageContext,
		message?: AssistantMessage,
		hideThinkingBlock = false,
		hiddenThinkingLabel = "Thinking...",
	) {
		super(ctx);
		this.hideThinkingBlock = hideThinkingBlock;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.addChild(this.contentContainer);
		if (message) this.updateContent(message);
	}

	protected rebuild(): void {
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	setHideThinkingBlock(hide: boolean): void {
		if (hide === this.hideThinkingBlock) return;
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		this.rebuild();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		return this.hasToolCalls ? lines : zone(lines);
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		const theme = this.ctx.theme.current;
		const pad = this.ctx.outputPad ?? 1;
		this.contentContainer.clear();
		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);
		if (hasVisibleContent) this.contentContainer.addChild(new Spacer(1));
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i]!;
			if (content.type === "text" && content.text.trim()) {
				this.contentContainer.addChild(
					new Markdown(safeText(content.text.trim()), pad, 0, this.ctx.theme.markdown, undefined, {
						transform: createMarkdownTransform(
							"assistant",
							this.isStreaming,
							this.ctx.markdownTransformers,
							this.ctx,
						),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i]!;
					if (thinkingContent.type !== "thinking") break;
					const thinking = thinkingContent.thinking.trim();
					if (thinking) thinkingBlocks.push(thinking);
				}
				i--;
				if (thinkingBlocks.length === 0) continue;
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const thinkingComponent = hidden
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), pad, 0)
					: new Markdown(
							safeText(thinkingBlocks.join("\n\n")),
							pad,
							0,
							this.ctx.theme.markdown,
							{ color: (text: string) => theme.fg("thinkingText", text), italic: true },
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.ctx.markdownTransformers,
									this.ctx,
								),
							},
						);
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						this.rebuild();
						this.ctx.requestRender();
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) this.contentContainer.addChild(new Spacer(1));
			}
		}
		// Incomplete/failed: shown after partial content. Tool cards show aborted/failed calls themselves.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		const notice = (text: string) => {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("error", safeText(text)), pad, 0));
		};
		if (message.stopReason === "length") notice("Response was truncated before completion.");
		else if (!hasToolCalls) {
			if (message.stopReason === "aborted")
				notice(
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted",
				);
			else if (message.stopReason === "error") notice(`Error: ${message.errorMessage || "Unknown error"}`);
		}
	}
}

/** The summary that replaced earlier context: collapsed to one line until expanded (DTUI CompactionComponent). */
export class CompactionSummaryComponent extends Themed {
	private summary: string;
	private expanded: boolean;
	private label: string;
	private collapsed: string;
	constructor(
		summary: string,
		expanded: boolean,
		ctx: MessageContext,
		options: { readonly label?: string; readonly collapsed?: string } = {},
	) {
		super(ctx);
		this.summary = summary;
		this.expanded = expanded;
		this.label = options.label ?? "[compaction]";
		this.collapsed = options.collapsed ?? "Earlier context summarized";
		this.rebuild();
	}
	setExpanded(expanded: boolean): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}
	protected rebuild(): void {
		this.clear();
		const theme = this.ctx.theme.current;
		const box = new Box(this.ctx.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
		const content = new Container();
		content.addChild(new Text(theme.fg("customMessageLabel", theme.bold(this.label)), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(
			this.expanded && this.summary.trim()
				? new Markdown(safeText(this.summary), 0, 0, this.ctx.theme.markdown, {
						color: (text: string) => theme.fg("customMessageText", text),
					})
				: new Text(
						theme.fg("customMessageText", `${this.collapsed} (`) +
							theme.fg("dim", this.ctx.keyText("app.tools.expand")) +
							theme.fg("customMessageText", " to expand)"),
						0,
						0,
					),
		);
		box.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				this.ctx.requestRender();
				return { handled: true };
			}),
		);
		this.addChild(box);
	}
}

/** A one-line muted or error notice in the transcript (DTUI `#addText`, pi's `showError`). */
export class NoticeComponent extends Themed {
	private text: string;
	private color: "muted" | "error" | "warning";
	constructor(text: string, color: "muted" | "error" | "warning", ctx: MessageContext) {
		super(ctx);
		this.text = text;
		this.color = color;
		this.rebuild();
	}
	update(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.rebuild();
	}
	protected rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.ctx.theme.current.fg(this.color, safeText(this.text)), this.ctx.outputPad ?? 1, 0));
	}
}
