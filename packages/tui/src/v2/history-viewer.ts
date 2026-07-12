import { getKeybindings, type KeybindingsManager } from "../keybindings.ts";
import type { Terminal } from "../terminal.ts";
import { cellsToAnsi, hardWrapStyledLine } from "./ansi.ts";
import { type Cell, CellBuffer } from "./cell-buffer.ts";
import { DEFAULT_TEXT_STYLE, type StyledLine } from "./styles.ts";

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
// The pager positions every row with an explicit CUP and never relies on autowrap, so a full-width
// row cannot trigger a deferred autowrap that scrolls the alt screen. Autowrap is held off for the
// whole session and restored on exit (plan §3 final-column policy).
const AUTOWRAP_OFF = "\x1b[?7l";
const AUTOWRAP_ON = "\x1b[?7h";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const CLEAR_SCREEN_HOME = "\x1b[2J\x1b[H";

/** Provides the complete logical history to browse, reflowed for a given width (oldest → newest). */
export interface HistorySource {
	/** Full logical history as styled lines for `width`; the viewer hard-wraps each to `width`. */
	historyLines(width: number): StyledLine[];
}

export interface HistoryViewerOptions {
	readonly terminal: Terminal;
	readonly source: HistorySource;
	readonly width: number;
	readonly rows: number;
	/** Invoked exactly once when the viewer exits, so the host can resume the live band. */
	readonly onExit?: () => void;
	/** Keybinding registry for navigation/close; defaults to the global registry. */
	readonly keybindings?: KeybindingsManager;
}

function isBlankCell(cell: Cell): boolean {
	return cell.cluster === " " && cell.styleId === 0 && cell.linkId === 0;
}

/**
 * In-Pi full-history viewer (plan §6 "Full-history browsability affordance").
 *
 * A self-contained alt-screen pager over the Ledger's complete logical history, reflowed at the
 * current width. It reaches every session row — including rows collapsed behind the re-commit replay
 * cap or evicted from the emulator's native scrollback — which the live band and terminal scrollback
 * alone cannot guarantee. It lives entirely on the alternate screen (`CSI ?1049h`/`l`), so the
 * primary screen and its scrollback are saved on entry and restored untouched on exit; the caller
 * then repaints the live band to return-to-live with the sole hardware caret.
 *
 * v1 overlay survey (plan §6): v1's SelectList/overlay machinery renders through the v1
 * Component `render(width) -> string` model and the v1 whole-tree compositor, and §1/§5 forbid
 * reusing the v1 LedgerContainer/Presenter. There is no existing alt-screen pager to reuse, so this
 * viewer composes the existing v2 primitives instead: {@link CellBuffer}/`CellRegion.putText` for
 * grapheme-aware layout, {@link hardWrapStyledLine} for width reflow, and {@link cellsToAnsi} — the
 * plan §3 sanitization choke point — for the only path where its rows become terminal bytes. A
 * hostile span carrying CR/LF/CSI is therefore reduced to inert printable bytes here too.
 *
 * Images: the pager only ever paints text through {@link cellsToAnsi}, so image blocks render as their
 * block renderer's textual/placeholder styled lines (e.g. `[image: name (WxH)]`). It deliberately
 * never emits live Kitty/iTerm2 graphics on the alternate screen, avoiding the graphics-lifecycle and
 * reserved-row hazards that native placement would incur here (plan §3 image discipline).
 *
 * Input is modal: while open, the viewer captures every key sequence so keystrokes never leak to the
 * editor beneath it. It parses only complete key sequences (via {@link KeybindingsManager}); it holds
 * no partial-parse state and strands nothing.
 */
export class HistoryViewer {
	private readonly terminal: Terminal;
	private readonly source: HistorySource;
	private readonly onExit: (() => void) | undefined;
	private readonly keybindings: KeybindingsManager;
	private width: number;
	private rows: number;
	private wrapped: StyledLine[] = [];
	private scrollTop = 0;
	private open = false;
	private exited = false;

	constructor(options: HistoryViewerOptions) {
		this.terminal = options.terminal;
		this.source = options.source;
		this.onExit = options.onExit;
		this.keybindings = options.keybindings ?? getKeybindings();
		this.width = Math.max(1, Math.trunc(options.width));
		this.rows = Math.max(1, Math.trunc(options.rows));
		this.reflow();
		// Open anchored at the newest content (the live tail), so entering the viewer keeps the user's
		// place and paging up walks back through older history.
		this.scrollTop = this.maxScrollTop();
	}

	get isOpen(): boolean {
		return this.open;
	}

	/** Enter the alternate screen and paint the first frame. Idempotent while already open. */
	openViewer(): void {
		if (this.open || this.exited) return;
		this.open = true;
		this.terminal.write(ALT_ENTER + AUTOWRAP_OFF + HIDE_CURSOR + CLEAR_SCREEN_HOME);
		this.paint();
	}

	/** Route one input sequence. Recognized navigation keys scroll; a close key exits to live view. */
	handleInput(data: string): void {
		if (!this.open) return;
		if (this.matches(data, "tui.history.close")) {
			this.close();
			return;
		}
		const page = Math.max(1, this.contentHeight() - 1);
		if (this.matches(data, "tui.history.scrollUp")) this.setScroll(this.scrollTop - 1);
		else if (this.matches(data, "tui.history.scrollDown")) this.setScroll(this.scrollTop + 1);
		else if (this.matches(data, "tui.history.pageUp")) this.setScroll(this.scrollTop - page);
		else if (this.matches(data, "tui.history.pageDown")) this.setScroll(this.scrollTop + page);
		else if (this.matches(data, "tui.history.top")) this.setScroll(0);
		else if (this.matches(data, "tui.history.bottom")) this.setScroll(this.maxScrollTop());
	}

	/** Reflow for new terminal dimensions and repaint (alt screen only). */
	resize(width: number, rows: number): void {
		this.width = Math.max(1, Math.trunc(width));
		this.rows = Math.max(1, Math.trunc(rows));
		this.reflow();
		this.scrollTop = Math.min(this.scrollTop, this.maxScrollTop());
		if (this.open) this.paint();
	}

	/** Exit the alternate screen, restore terminal modes, and fire {@link onExit} exactly once. */
	close(): void {
		if (!this.open) return;
		this.open = false;
		this.terminal.write(SHOW_CURSOR + AUTOWRAP_ON + ALT_EXIT);
		if (!this.exited) {
			this.exited = true;
			this.onExit?.();
		}
	}

	private matches(data: string, action: Parameters<KeybindingsManager["matches"]>[1]): boolean {
		return this.keybindings.matches(data, action);
	}

	private reflow(): void {
		const rows: StyledLine[] = [];
		for (const line of this.source.historyLines(this.width)) {
			for (const visual of hardWrapStyledLine(line, this.width)) rows.push(visual);
		}
		this.wrapped = rows;
	}

	private contentHeight(): number {
		return Math.max(0, this.rows - 1);
	}

	private maxScrollTop(): number {
		return Math.max(0, this.wrapped.length - this.contentHeight());
	}

	private setScroll(next: number): void {
		const clamped = Math.max(0, Math.min(this.maxScrollTop(), Math.trunc(next)));
		if (clamped === this.scrollTop) return;
		this.scrollTop = clamped;
		this.paint();
	}

	private paint(): void {
		const contentHeight = this.contentHeight();
		const buffer = new CellBuffer(this.width, this.rows);
		for (let row = 0; row < contentHeight; row++) {
			const line = this.wrapped[this.scrollTop + row];
			if (line) buffer.putText(0, row, line);
		}
		buffer.putText(0, contentHeight, this.statusLine());

		// Re-assert autowrap-off + hidden cursor every frame so a mode reset from resize/SIGCONT handback
		// cannot leak a deferred autowrap or a stray caret into the alt screen (self-contained frame).
		let out = SYNC_BEGIN + AUTOWRAP_OFF + HIDE_CURSOR;
		for (let row = 0; row < this.rows; row++) {
			out += `\x1b[${row + 1};1H${CLEAR_LINE}${this.serializeRow(buffer, row)}`;
		}
		out += SYNC_END;
		this.terminal.write(out);
	}

	private statusLine(): StyledLine {
		const total = this.wrapped.length;
		const contentHeight = this.contentHeight();
		const first = total === 0 ? 0 : this.scrollTop + 1;
		const last = Math.min(total, this.scrollTop + contentHeight);
		const position = total === 0 ? "empty" : `${first}-${last}/${total}`;
		// Lead with the position so the row count survives truncation at narrow widths.
		const text = ` ${position} · history · ↑/↓ scroll · PgUp/PgDn page · g/G ends · q live `;
		return hardWrapStyledLine([{ text, style: { ...DEFAULT_TEXT_STYLE, inverse: true } }], this.width)[0] ?? [];
	}

	/** Serialize a single band-width row through the §3-sanitizing {@link cellsToAnsi} choke point. */
	private serializeRow(buffer: CellBuffer, row: number): string {
		let last = -1;
		for (let column = 0; column < buffer.width; column++) {
			if (!isBlankCell(buffer.get(row, column))) last = column;
		}
		if (last < 0) return "";
		const cells: Cell[] = [];
		for (let column = 0; column <= last; column++) cells.push(buffer.get(row, column));
		return cellsToAnsi(cells, buffer.styles, buffer.links);
	}
}
