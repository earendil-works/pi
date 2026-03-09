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
	onTranscriptSelectionCopy?: (text: string) => void;
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

interface TranscriptSelectionState {
	anchorLine: number;
	anchorColumn: number;
	focusLine: number;
	focusColumn: number;
	hasDragged: boolean;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function normalizeSelectedTextLines(lines: string[]): string {
	const stripped = lines.map((line) => stripAnsi(line).trimEnd());
	const nonEmpty = stripped.filter((line) => line.trim().length > 0);
	if (nonEmpty.length === 0) return "";

	const sharedIndent = nonEmpty.reduce((min, line) => {
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		return Math.min(min, indent);
	}, Number.POSITIVE_INFINITY);

	return stripped
		.map((line) => line.slice(Number.isFinite(sharedIndent) ? sharedIndent : 0))
		.join("\n")
		.trim();
}

function clampColumn(x: number, width: number): number {
	return Math.max(1, Math.min(width, x));
}

function sliceSelectedColumns(text: string, startColumn: number, endColumn: number): string {
	const normalized = padToWidth(stripAnsi(text), Math.max(startColumn, endColumn));
	const start = Math.max(0, Math.min(startColumn, endColumn) - 1);
	const end = Math.max(start + 1, Math.max(startColumn, endColumn));
	return normalized.slice(start, end).trimEnd();
}

export class ChatLayoutComponent implements Component {
	private readonly chatContent: Component;
	private readonly composerContent: Component;
	private readonly inputTarget: Component;
	private readonly interceptInput?: (data: string) => string;
	private readonly onTranscriptSelectionCopy?: (text: string) => void;
	private readonly footer: Component;
	private readonly getComposerLabel: () => string;
	private readonly getComposerMetaLabel?: () => string;
	private readonly getComposerBorderColor: () => (text: string) => string;
	private readonly updateComposerViewport: (maxBodyRows: number) => void;
	private viewportTopLine: number | null = null;
	private lastChatHeight = 1;
	private lastChatLineCount = 0;
	private lastChatStartLine = 0;
	private lastChatContentWidth = 1;
	private lastChatHasScrollbar = false;
	private lastRenderWidth = 0;
	private scrollbarDragState: ChatScrollbarDragState | null = null;
	private transcriptSelectionState: TranscriptSelectionState | null = null;
	private lastChatLines: string[] = [];

	constructor(options: ChatLayoutOptions) {
		this.chatContent = options.chatContent;
		this.composerContent = options.composerContent;
		this.inputTarget = options.inputTarget;
		this.interceptInput = options.interceptInput;
		this.onTranscriptSelectionCopy = options.onTranscriptSelectionCopy;
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
			if (this.handleTranscriptSelectionPointerDown(match)) {
				return "";
			}
			return match;
		});
		remaining = remaining.replace(/\x1b\[<32;\d+;\d+M/g, (match) => {
			if (this.handleScrollbarDrag(match)) {
				return "";
			}
			if (this.handleTranscriptSelectionDrag(match)) {
				return "";
			}
			return match;
		});
		remaining = remaining.replace(/\x1b\[<\d+;\d+;\d+m/g, (match) => {
			if (this.handleScrollbarRelease(match)) {
				return "";
			}
			if (this.handleTranscriptSelectionRelease(match)) {
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
		const fullWidth = Math.max(1, width);
		const frameWidth = Math.max(1, width - 1);
		const fullWidthLines = this.chatContent.render(fullWidth);
		if (fullWidthLines.length <= height) {
			this.lastChatLines = fullWidthLines;
			this.lastChatHeight = height;
			this.lastChatLineCount = fullWidthLines.length;
			this.lastChatContentWidth = fullWidth;
			this.lastChatHasScrollbar = false;
			this.viewportTopLine = null;
			this.lastChatStartLine = 0;
			return fullWidthLines.map((line, index) =>
				this.isTranscriptLineSelected(index)
					? this.highlightSelectedLine(line, fullWidth, this.selectedColumnsForLine(index))
					: line,
			);
		}

		const contentWidth = Math.max(1, frameWidth - 1);
		const allLines = this.chatContent.render(contentWidth);
		this.lastChatLines = allLines;
		this.lastChatHeight = height;
		this.lastChatLineCount = allLines.length;
		this.lastChatContentWidth = contentWidth;
		this.lastChatHasScrollbar = true;
		const maxStartLine = Math.max(0, allLines.length - height);

		let start = this.viewportTopLine ?? maxStartLine;
		start = Math.max(0, Math.min(maxStartLine, start));
		if (start >= maxStartLine) {
			this.viewportTopLine = null;
			start = maxStartLine;
		} else {
			this.viewportTopLine = start;
		}
		this.lastChatStartLine = start;
		const visibleLines = allLines.slice(start, start + height);
		const thumbSize = Math.max(1, Math.floor((height / allLines.length) * height));
		const scrollableRange = Math.max(1, allLines.length - height);
		const thumbTravel = Math.max(0, height - thumbSize);
		const thumbStart = thumbTravel === 0 ? 0 : Math.floor((start / scrollableRange) * thumbTravel);

		return visibleLines.map((line, index) => {
			const absoluteLine = start + index;
			const content = this.isTranscriptLineSelected(absoluteLine)
				? this.highlightSelectedLine(line, contentWidth, this.selectedColumnsForLine(absoluteLine))
				: padToWidth(line, contentWidth);
			const scrollbarChar = index >= thumbStart && index < thumbStart + thumbSize ? "█" : "░";
			return content + scrollbarChar;
		});
	}

	private scroll(delta: number): void {
		const maxStartLine = Math.max(0, this.lastChatLineCount - this.lastChatHeight);
		if (maxStartLine === 0) {
			this.viewportTopLine = null;
			return;
		}

		const currentStartLine = this.viewportTopLine ?? maxStartLine;
		const nextStartLine = Math.max(0, Math.min(maxStartLine, currentStartLine - delta));
		this.viewportTopLine = nextStartLine >= maxStartLine ? null : nextStartLine;
	}

	private getScrollbarGeometry(): ChatScrollbarGeometry | null {
		if (this.lastChatLineCount <= this.lastChatHeight) {
			return null;
		}

		const visibleHeight = this.lastChatHeight;
		const maxScrollOffset = Math.max(0, this.lastChatLineCount - visibleHeight);
		const thumbSize = Math.max(1, Math.floor((visibleHeight / this.lastChatLineCount) * visibleHeight));
		const trackTravel = Math.max(0, visibleHeight - thumbSize);
		const start = Math.max(0, Math.min(maxScrollOffset, this.lastChatStartLine));
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
		if (!this.lastChatHasScrollbar) return false;
		return x === this.lastChatContentWidth + 1;
	}

	private getChatMouseRow(y: number): number {
		return y - 1;
	}

	private isChatContentColumnForWidth(x: number): boolean {
		return x >= 1 && x <= this.lastChatContentWidth;
	}

	private isTranscriptLineSelected(lineIndex: number): boolean {
		if (!this.transcriptSelectionState) return false;
		const start = Math.min(this.transcriptSelectionState.anchorLine, this.transcriptSelectionState.focusLine);
		const end = Math.max(this.transcriptSelectionState.anchorLine, this.transcriptSelectionState.focusLine);
		return lineIndex >= start && lineIndex <= end;
	}

	private selectedColumnsForLine(lineIndex: number): { startColumn: number; endColumn: number } {
		if (!this.transcriptSelectionState) {
			return { startColumn: 1, endColumn: 1 };
		}

		const { anchorLine, anchorColumn, focusLine, focusColumn } = this.transcriptSelectionState;
		const startsBefore = anchorLine < focusLine || (anchorLine === focusLine && anchorColumn <= focusColumn);
		const startLine = startsBefore ? anchorLine : focusLine;
		const startColumn = startsBefore ? anchorColumn : focusColumn;
		const endLine = startsBefore ? focusLine : anchorLine;
		const endColumn = startsBefore ? focusColumn : anchorColumn;
		const plain = stripAnsi(this.lastChatLines[lineIndex] ?? "");
		const width = Math.max(1, plain.length || this.lastRenderWidth - 2);

		if (startLine === endLine) {
			return { startColumn, endColumn };
		}
		if (lineIndex === startLine) {
			return { startColumn, endColumn: width };
		}
		if (lineIndex === endLine) {
			return { startColumn: 1, endColumn };
		}
		return { startColumn: 1, endColumn: width };
	}

	private highlightSelectedLine(
		line: string,
		width: number,
		columns: { startColumn: number; endColumn: number },
	): string {
		const plain = padToWidth(stripAnsi(line), width);
		const start = Math.max(0, Math.min(columns.startColumn, columns.endColumn) - 1);
		const end = Math.max(start + 1, Math.min(width, Math.max(columns.startColumn, columns.endColumn)));
		return `${plain.slice(0, start)}\x1b[7m${plain.slice(start, end)}\x1b[27m${plain.slice(end)}`;
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
				startScrollOffset: this.lastChatStartLine,
				geometry,
			};
			return true;
		}

		const nextStartLine = this.scrollOffsetFromThumbRow(clickedRow, geometry);
		this.viewportTopLine = nextStartLine >= geometry.maxScrollOffset ? null : nextStartLine;
		this.scrollbarDragState = null;
		return true;
	}

	private handleTranscriptSelectionPointerDown(data: string): boolean {
		const position = this.parseMousePosition(data);
		if (!position) return false;
		if (!this.isChatContentColumnForWidth(position.x)) return false;

		const clickedRow = this.getChatMouseRow(position.y);
		if (clickedRow < 0 || clickedRow >= this.lastChatHeight) return false;

		const absoluteLine = this.lastChatStartLine + clickedRow;
		this.transcriptSelectionState = {
			anchorLine: absoluteLine,
			anchorColumn: clampColumn(position.x, this.lastChatContentWidth),
			focusLine: absoluteLine,
			focusColumn: clampColumn(position.x, this.lastChatContentWidth),
			hasDragged: false,
		};
		return true;
	}

	private handleTranscriptSelectionDrag(data: string): boolean {
		const position = this.parseMousePosition(data);
		if (!position || !this.transcriptSelectionState) return false;
		if (!this.isChatContentColumnForWidth(position.x)) return false;
		const clickedRow = this.getChatMouseRow(position.y);
		if (clickedRow < 0 || clickedRow >= this.lastChatHeight) return false;
		this.transcriptSelectionState.focusLine = this.lastChatStartLine + clickedRow;
		this.transcriptSelectionState.focusColumn = clampColumn(position.x, this.lastChatContentWidth);
		this.transcriptSelectionState.hasDragged = true;
		return true;
	}

	private handleTranscriptSelectionRelease(data: string): boolean {
		const position = this.parseMousePosition(data);
		if (!position || !this.transcriptSelectionState) return false;
		const shouldConsume = this.isChatContentColumnForWidth(position.x);
		if (shouldConsume && this.transcriptSelectionState.hasDragged) {
			const selectedText = this.getSelectedTranscriptText();
			if (selectedText.length > 0) {
				this.onTranscriptSelectionCopy?.(selectedText);
			}
		}
		this.transcriptSelectionState = null;
		return shouldConsume;
	}

	private getSelectedTranscriptText(): string {
		if (!this.transcriptSelectionState) return "";
		const start = Math.min(this.transcriptSelectionState.anchorLine, this.transcriptSelectionState.focusLine);
		const end = Math.max(this.transcriptSelectionState.anchorLine, this.transcriptSelectionState.focusLine);
		const selectedLines: string[] = [];
		for (let lineIndex = start; lineIndex <= end; lineIndex++) {
			const columns = this.selectedColumnsForLine(lineIndex);
			selectedLines.push(
				sliceSelectedColumns(this.lastChatLines[lineIndex] ?? "", columns.startColumn, columns.endColumn),
			);
		}
		return normalizeSelectedTextLines(selectedLines);
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
		const nextOffset = Math.max(0, Math.min(geometry.maxScrollOffset, startScrollOffset + scrollDelta));
		if (nextOffset === this.lastChatStartLine) return false;

		this.viewportTopLine = nextOffset >= geometry.maxScrollOffset ? null : nextOffset;
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
		return Math.round((thumbStart / geometry.trackTravel) * geometry.maxScrollOffset);
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
