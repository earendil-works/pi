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
	getComposerMetaLabel?: () => string;
	getComposerBorderColor: () => (text: string) => string;
	updateComposerViewport: (maxBodyRows: number) => void;
}

interface ChatScrollbarGeometry {
	visibleHeight: number;
	maxScrollOffset: number;
	thumbStart: number;
	thumbSize: number;
	trackTravel: number;
}

interface ChatScrollbarDragState {
	startMouseRow: number;
	startScrollOffset: number;
	geometry: ChatScrollbarGeometry;
}

export class ChatLayoutComponent implements Component {
	private readonly chatContent: Component;
	private readonly composerContent: Component;
	private readonly inputTarget: Component;
	private readonly interceptInput?: (data: string) => string;
	private readonly footer: Component;
	private readonly getComposerLabel: () => string;
	private readonly getComposerMetaLabel?: () => string;
	private readonly getComposerBorderColor: () => (text: string) => string;
	private readonly updateComposerViewport: (maxBodyRows: number) => void;
	private scrollOffset = 0;
	private lastChatHeight = 1;
	private lastChatLineCount = 0;
	private lastRenderWidth = 0;
	private scrollbarDragState: ChatScrollbarDragState | null = null;

	constructor(options: ChatLayoutOptions) {
		this.chatContent = options.chatContent;
		this.composerContent = options.composerContent;
		this.inputTarget = options.inputTarget;
		this.interceptInput = options.interceptInput;
		this.footer = options.footer;
		this.getComposerLabel = options.getComposerLabel;
		this.getComposerMetaLabel = options.getComposerMetaLabel;
		this.getComposerBorderColor = options.getComposerBorderColor;
		this.updateComposerViewport = options.updateComposerViewport;
	}

	invalidate(): void {
		this.chatContent.invalidate?.();
		this.composerContent.invalidate?.();
	}

	handleInput(data: string): void {
		let remaining = data;
		remaining = remaining.replace(/\x1b\[<0;\d+;\d+M/g, (match) => {
			if (this.handleScrollbarPointerDown(match)) {
				return "";
			}
			return match;
		});
		remaining = remaining.replace(/\x1b\[<32;\d+;\d+M/g, (match) => {
			if (this.handleScrollbarDrag(match)) {
				return "";
			}
			return match;
		});
		remaining = remaining.replace(/\x1b\[<\d+;\d+;\d+m/g, (match) => {
			if (this.handleScrollbarRelease(match)) {
				return "";
			}
			return match;
		});
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
		this.lastRenderWidth = width;
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

	private getScrollbarGeometry(): ChatScrollbarGeometry | null {
		if (this.lastChatLineCount <= this.lastChatHeight) {
			return null;
		}

		const visibleHeight = this.lastChatHeight;
		const maxScrollOffset = Math.max(0, this.lastChatLineCount - visibleHeight);
		const thumbSize = Math.max(1, Math.floor((visibleHeight / this.lastChatLineCount) * visibleHeight));
		const trackTravel = Math.max(0, visibleHeight - thumbSize);
		const start = Math.max(0, this.lastChatLineCount - visibleHeight - this.scrollOffset);
		const thumbStart = trackTravel === 0 ? 0 : Math.floor((start / Math.max(1, maxScrollOffset)) * trackTravel);

		return { visibleHeight, maxScrollOffset, thumbStart, thumbSize, trackTravel };
	}

	private parseMousePosition(data: string): { x: number; y: number } | null {
		const match = data.match(/\x1b\[<\d+;(\d+);(\d+)[Mm]/);
		if (!match) return null;
		return {
			x: Number.parseInt(match[1], 10),
			y: Number.parseInt(match[2], 10),
		};
	}

	private isChatScrollbarColumnForWidth(x: number): boolean {
		return x === Math.max(2, this.lastRenderWidth - 1);
	}

	private getChatMouseRow(y: number): number {
		return y - 1;
	}

	private handleScrollbarPointerDown(data: string): boolean {
		const position = this.parseMousePosition(data);
		const geometry = this.getScrollbarGeometry();
		if (!position || !geometry) return false;
		if (!this.isChatScrollbarColumnForWidth(position.x)) return false;

		const clickedRow = this.getChatMouseRow(position.y);
		if (clickedRow < 0 || clickedRow >= geometry.visibleHeight) return false;

		const isOnThumb = clickedRow >= geometry.thumbStart && clickedRow < geometry.thumbStart + geometry.thumbSize;
		if (isOnThumb) {
			this.scrollbarDragState = {
				startMouseRow: clickedRow,
				startScrollOffset: this.scrollOffset,
				geometry,
			};
			return true;
		}

		this.scrollOffset = this.scrollOffsetFromThumbRow(clickedRow, geometry);
		this.scrollbarDragState = null;
		return true;
	}

	private handleScrollbarDrag(data: string): boolean {
		const position = this.parseMousePosition(data);
		if (!position || !this.scrollbarDragState) return false;
		if (!this.isChatScrollbarColumnForWidth(position.x)) return false;

		const clickedRow = this.getChatMouseRow(position.y);
		const { geometry, startMouseRow, startScrollOffset } = this.scrollbarDragState;
		if (geometry.maxScrollOffset === 0 || geometry.trackTravel === 0) return false;

		const rowDelta = clickedRow - startMouseRow;
		const scrollDelta = Math.round((rowDelta / geometry.trackTravel) * geometry.maxScrollOffset);
		const nextOffset = Math.max(0, Math.min(geometry.maxScrollOffset, startScrollOffset - scrollDelta));
		if (nextOffset === this.scrollOffset) return false;

		this.scrollOffset = nextOffset;
		return true;
	}

	private handleScrollbarRelease(data: string): boolean {
		const position = this.parseMousePosition(data);
		if (!position || !this.scrollbarDragState) return false;
		this.scrollbarDragState = null;
		return this.isChatScrollbarColumnForWidth(position.x);
	}

	private scrollOffsetFromThumbRow(clickedRow: number, geometry: ChatScrollbarGeometry): number {
		if (geometry.maxScrollOffset === 0 || geometry.trackTravel === 0) {
			return 0;
		}

		const thumbStart = Math.max(0, Math.min(geometry.trackTravel, clickedRow));
		const start = Math.round((thumbStart / geometry.trackTravel) * geometry.maxScrollOffset);
		return Math.max(0, Math.min(geometry.maxScrollOffset, geometry.maxScrollOffset - start));
	}

	private renderComposer(width: number, terminalRows: number): string[] {
		const frameWidth = Math.max(4, width - 1);
		const border = this.getComposerBorderColor();
		const label = this.getComposerLabel();
		const metaLabel = this.getComposerMetaLabel?.() ?? "";
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
		let bottomLine = `${border("╰")}${border("─".repeat(frameWidth - 2))}${border("╯")}`;
		if (metaLabel.length > 0) {
			const metaWidth = visibleWidth(metaLabel);
			const leftFill = Math.max(0, frameWidth - metaWidth - 4);
			bottomLine = `${border("╰")}${border("─".repeat(leftFill))} ${metaLabel} ${border("╯")}`;
		}
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
