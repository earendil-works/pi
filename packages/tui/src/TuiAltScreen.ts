import { getKeybindings } from "./keybindings.ts";
import type { Terminal } from "./terminal.ts";
import {
	cropKittyImageLine,
	deleteAllKittyImages,
	getCapabilities,
	getKittyImageMetadata,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import { CURSOR_MARKER, type TUI, TuiBase } from "./tui.ts";
import {
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "./utils.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

interface SelectionPoint {
	row: number;
	col: number;
}

interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

export interface TuiAltScreenOptions {
	/** Number of logical lines moved for each mouse-wheel event. */
	wheelScrollLines?: number;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	mouse?: boolean;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements TUI {
	private previousScreen: string[] = [];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private scrollTop = 0;
	private contentLineCount = 0;
	private stickToBottom = true;
	private altScreenActive = false;
	private imageProtocol: ImageProtocol = null;
	private savedCapabilities?: TerminalCapabilities;
	private selectionAnchor?: SelectionPoint;
	private selectionFocus?: SelectionPoint;
	private pressedUrl?: string;
	private selectionDragged = false;
	private readonly wheelScrollLines: number;
	private readonly mouseEnabled: boolean;
	private readonly openUrl?: (url: string) => void;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.wheelScrollLines = Math.max(1, Math.floor(options.wheelScrollLines ?? 3));
		this.mouseEnabled = options.mouse ?? true;
		this.openUrl = options.openUrl;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	get viewportTop(): number {
		return this.scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.stickToBottom;
	}

	protected override beforeTerminalStart(): void {
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.resetRenderState();
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? ENABLE_MOUSE : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(): void {
		if (!this.altScreenActive) return;
		this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
	}

	protected override afterTerminalStop(): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
		for (let row = 0; row < this.lastDocument.length; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
		}
		buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
		this.terminal.write(buffer);
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	private deleteKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
	}

	scrollBy(lines: number): void {
		if (lines === 0) return;
		const height = Math.max(1, this.terminal.rows);
		const maxScrollTop = Math.max(0, this.contentLineCount - height);
		const currentTop = this.stickToBottom ? maxScrollTop : this.scrollTop;
		this.scrollTop = Math.max(0, Math.min(maxScrollTop, currentTop + lines));
		this.stickToBottom = this.scrollTop === maxScrollTop;
		this.requestRender();
	}

	scrollToTop(): void {
		this.scrollTop = 0;
		this.stickToBottom = this.contentLineCount <= this.terminal.rows;
		this.requestRender();
	}

	scrollToBottom(): void {
		this.stickToBottom = true;
		this.scrollTop = Math.max(0, this.contentLineCount - this.terminal.rows);
		this.requestRender();
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		const wheelDirection = this.parseWheelDirection(data);
		if (wheelDirection !== undefined) {
			this.scrollBy(wheelDirection * this.wheelScrollLines);
			return { consume: true };
		}
		const mouseEvent = this.parseSgrMouseEvent(data);
		if (mouseEvent) {
			this.handleSelectionMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };

		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			this.scrollBy(-Math.max(1, this.terminal.rows - 1));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			this.scrollBy(Math.max(1, this.terminal.rows - 1));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			this.scrollToTop();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	private parseWheelDirection(data: string): -1 | 1 | undefined {
		const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction === 0) return -1;
			if (direction === 1) return 1;
			return undefined;
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction === 0) return -1;
			if (direction === 1) return 1;
			return undefined;
		}
		return undefined;
	}

	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1], 10),
			x: Number.parseInt(match[2], 10) - 1,
			y: Number.parseInt(match[3], 10) - 1,
			release: match[4] === "m",
		};
	}

	private handleSelectionMouseEvent(event: SgrMouseEvent): void {
		if ((event.button & 3) !== 0) return;
		const viewportRow = Math.max(0, Math.min(this.terminal.rows - 1, event.y));
		const point = {
			row: this.scrollTop + viewportRow,
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		};
		if (event.release) {
			if (!this.selectionAnchor) return;
			this.selectionFocus = point;
			const clickedUrl =
				!this.selectionDragged && this.selectionAnchor.row === point.row && this.selectionAnchor.col === point.col
					? this.pressedUrl
					: undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.requestRender();
				return;
			}
			this.copySelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionAnchor) return;
			this.selectionDragged = true;
			this.pressedUrl = undefined;
			this.selectionFocus = point;
			this.requestRender();
			return;
		}
		this.selectionAnchor = point;
		this.selectionFocus = point;
		this.selectionDragged = false;
		this.pressedUrl = getOsc8LinkAtColumn(this.previousScreen[viewportRow] ?? "", point.col);
		this.requestRender();
	}

	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		const anchorBeforeFocus =
			this.selectionAnchor.row < this.selectionFocus.row ||
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		if (
			this.selectionAnchor.row === this.selectionFocus.row &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		return anchorBeforeFocus
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
	): { start: number; end: number } {
		const lineWidth = visibleWidth(line);
		let start = 0;
		let end = lineWidth;
		if (row === selection.start.row) {
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth);
		}
		return { start, end };
	}

	private copySelectionToClipboard(): void {
		const selection = this.getSelectionBounds();
		if (!selection) return;
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = this.lastDocument[row] ?? "";
			const columns = this.getSelectionColumns(line, row, selection);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				).trimEnd(),
			);
		}
		const text = lines.join("\n");
		if (text.length === 0) return;
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	}

	private applySelection(screen: string[]): string[] {
		const selection = this.getSelectionBounds();
		if (!selection) return screen;
		return screen.map((line, viewportRow) => {
			const row = this.scrollTop + viewportRow;
			if (row < selection.start.row || row > selection.end.row || isImageLine(line)) return line;
			const lineWidth = visibleWidth(line);
			const columns = this.getSelectionColumns(line, row, selection);
			if (columns.end <= columns.start) return line;
			const before = sliceByColumn(line, 0, columns.start, true);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			return `${before}\x1b[7m${selected}\x1b[27m${after}`;
		});
	}

	private isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const contentLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		this.contentLineCount = contentLines.length;
		this.lastDocument = this.applyLineResets(contentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
			(line) => {
				if (isImageLine(line) || visibleWidth(line) <= width) return line;
				return sliceByColumn(line, 0, width, true);
			},
		);

		const maxScrollTop = Math.max(0, contentLines.length - height);
		if (this.stickToBottom) {
			this.scrollTop = maxScrollTop;
		} else {
			this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScrollTop));
			this.stickToBottom = this.scrollTop === maxScrollTop;
		}

		let screen = contentLines.slice(this.scrollTop, this.scrollTop + height);
		if (this.scrollTop > 0) {
			for (let imageRow = this.scrollTop - 1; imageRow >= 0; imageRow--) {
				const imageLine = contentLines[imageRow] ?? "";
				const metadata = getKittyImageMetadata(imageLine);
				if (metadata) {
					const hiddenRows = this.scrollTop - imageRow;
					if (hiddenRows < metadata.rows) {
						const visibleRows = Math.min(height, metadata.rows - hiddenRows);
						screen[0] = cropKittyImageLine(imageLine, hiddenRows, visibleRows);
					}
					break;
				}
				if (imageLine !== "") break;
			}
		}
		while (screen.length < height) screen.push("");
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		screen = this.applySelection(screen);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => {
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		const fullRedraw =
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		const imagesNeedRedraw = screen.some(
			(line, row) =>
				line !== this.previousScreen[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")),
		);

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			buffer += `${this.deleteKittyImages()}\x1b[2J`;
		} else if (imagesNeedRedraw) {
			buffer += this.imageProtocol === "iterm2" ? "\x1b[2J" : this.deleteKittyImages();
		}

		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
			buffer += `\x1b[${row + 1};1H\x1b[2K${screen[row] ?? ""}`;
		}

		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.terminal.write(buffer);

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
	}
}
