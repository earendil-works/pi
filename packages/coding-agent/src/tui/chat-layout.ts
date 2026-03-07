import { type Component, Container, visibleWidth } from "@kennyfrc/mu-tui";
import { theme } from "../theme/theme.js";

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function stripTrailingViewportScrollbar(text: string): string {
	return text.replace(/[█░]$/u, "");
}

interface ChatLayoutOptions {
	chatContent: Component;
	composerContent: Component;
	inputTarget: Component;
	interceptInput?: (data: string) => string;
	footer: Component;
	getComposerLabel: () => string;
	getComposerBorderColor: () => (text: string) => string;
	updateComposerViewport: (maxBodyRows: number) => void;
}

export class ChatLayoutComponent implements Component {
	private readonly chatContent: Component;
	private readonly composerContent: Component;
	private readonly inputTarget: Component;
	private readonly interceptInput?: (data: string) => string;
	private readonly footer: Component;
	private readonly getComposerLabel: () => string;
	private readonly getComposerBorderColor: () => (text: string) => string;
	private readonly updateComposerViewport: (maxBodyRows: number) => void;
	private scrollOffset = 0;
	private lastChatHeight = 1;
	private lastChatLineCount = 0;

	constructor(options: ChatLayoutOptions) {
		this.chatContent = options.chatContent;
		this.composerContent = options.composerContent;
		this.inputTarget = options.inputTarget;
		this.interceptInput = options.interceptInput;
		this.footer = options.footer;
		this.getComposerLabel = options.getComposerLabel;
		this.getComposerBorderColor = options.getComposerBorderColor;
		this.updateComposerViewport = options.updateComposerViewport;
	}

	invalidate(): void {
		this.chatContent.invalidate?.();
		this.composerContent.invalidate?.();
	}

	handleInput(data: string): void {
		let remaining = data;
		remaining = remaining.replace(/\x1b\[<64;\d+;\d+[Mm]/g, () => {
			this.scroll(3);
			return "";
		});
		remaining = remaining.replace(/\x1b\[<65;\d+;\d+[Mm]/g, () => {
			this.scroll(-3);
			return "";
		});
		remaining = remaining.replace(/\x1b\[5~/g, () => {
			this.scroll(Math.max(1, this.lastChatHeight - 1));
			return "";
		});
		remaining = remaining.replace(/\x1b\[6~/g, () => {
			this.scroll(-Math.max(1, this.lastChatHeight - 1));
			return "";
		});
		if (this.interceptInput) {
			remaining = this.interceptInput(remaining);
		}
		if (remaining.length > 0) {
			this.inputTarget.handleInput?.(remaining);
		}
	}

	wantsMouseTracking(): boolean {
		return true;
	}

	render(width: number): string[] {
		const terminalRows = process.stdout.rows || 24;
		const footerRows = this.footer.render(width).length;
		const composerLines = this.renderComposer(width, terminalRows);
		const composerGap = 1;
		const chatHeight = Math.max(1, terminalRows - footerRows - composerLines.length - composerGap);
		const chatLines = this.renderChat(width, chatHeight);
		return [...chatLines, ...Array(composerGap).fill(""), ...composerLines];
	}

	private renderChat(width: number, height: number): string[] {
		const frameWidth = Math.max(2, width - 1);
		const contentWidth = Math.max(1, frameWidth - 1);
		const allLines = this.chatContent.render(contentWidth);
		this.lastChatHeight = height;
		this.lastChatLineCount = allLines.length;
		const maxScrollOffset = Math.max(0, allLines.length - height);
		if (this.scrollOffset > maxScrollOffset) {
			this.scrollOffset = maxScrollOffset;
		}
		if (allLines.length <= height) {
			return allLines;
		}

		const start = Math.max(0, allLines.length - height - this.scrollOffset);
		const visibleLines = allLines.slice(start, start + height);
		const thumbSize = Math.max(1, Math.floor((height / allLines.length) * height));
		const scrollableRange = Math.max(1, allLines.length - height);
		const thumbTravel = Math.max(0, height - thumbSize);
		const thumbStart = thumbTravel === 0 ? 0 : Math.floor((start / scrollableRange) * thumbTravel);

		return visibleLines.map((line, index) => {
			const scrollbarChar = index >= thumbStart && index < thumbStart + thumbSize ? "█" : "░";
			return padToWidth(line, contentWidth) + scrollbarChar;
		});
	}

	private scroll(delta: number): void {
		const maxScrollOffset = Math.max(0, this.lastChatLineCount - this.lastChatHeight);
		this.scrollOffset = Math.max(0, Math.min(maxScrollOffset, this.scrollOffset + delta));
	}

	private renderComposer(width: number, terminalRows: number): string[] {
		const frameWidth = Math.max(4, width - 1);
		const border = this.getComposerBorderColor();
		const label = this.getComposerLabel();
		const innerWidth = Math.max(1, frameWidth - 4);
		const maxBodyRows = Math.max(2, Math.floor(terminalRows / 3));
		this.updateComposerViewport(maxBodyRows);
		const title = theme.fg("muted", label);
		const titleFill = Math.max(0, frameWidth - 4 - visibleWidth(title));
		const topLine = `${border("╭─")} ${title}${border("─".repeat(titleFill))}${border("╮")}`;

		const content = this.composerContent
			.render(innerWidth)
			.slice(0, maxBodyRows)
			.map((line) => stripTrailingViewportScrollbar(line));
		while (content.length < 2) {
			content.push("");
		}

		const body = content.map((line) => `${border("│")} ${padToWidth(line, innerWidth)} ${border("│")}`);
		const bottomLine = `${border("╰")}${border("─".repeat(frameWidth - 2))}${border("╯")}`;
		return [topLine, ...body, bottomLine];
	}
}

export function createChatContentContainer(
	topChrome: Container,
	chatContainer: Container,
	pendingMessagesContainer: Container,
	statusContainer: Container,
): Container {
	const content = new Container();
	content.addChild(topChrome);
	content.addChild(chatContainer);
	content.addChild(pendingMessagesContainer);
	content.addChild(statusContainer);
	return content;
}
