import type { Terminal } from "../terminal.ts";

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR_LINE = "\x1b[2K";
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

/** One incremental band update: serialized cells starting at a band-local row/column. */
export interface SerializedDamageRun {
	readonly row: number;
	readonly column: number;
	readonly text: string;
}

export interface PresentBand {
	readonly width: number;
	readonly height: number;
	/** Full serialized band rows (length === height). Required for commits and height changes. */
	readonly repaint?: readonly string[];
	/** Incremental band-local updates. Used only when height is unchanged and no commits flush. */
	readonly damage?: readonly SerializedDamageRun[];
}

export interface PresentCaret {
	readonly row: number;
	readonly column: number;
}

export interface PresentFrame {
	/** Serialized scrollback lines to push above the band, in commit order. */
	readonly commitLines?: readonly string[];
	readonly band: PresentBand;
	/** Focused, visible caret in band-local coordinates. Absent => park and hide. */
	readonly caret?: PresentCaret;
	/** DECTCEM policy for a focused caret. Ignored when caret is absent. */
	readonly showCursor?: boolean;
}

export interface PresentResult {
	readonly bytes: string;
	readonly fullRepaint: boolean;
}

function moveVertical(delta: number): string {
	if (delta > 0) return `\x1b[${delta}B`;
	if (delta < 0) return `\x1b[${-delta}A`;
	return "";
}

function moveToColumn(column: number): string {
	// Always return to column 0 first, then step right, so horizontal drift never accumulates.
	return column > 0 ? `\r\x1b[${column}C` : "\r";
}

/**
 * Owns the physical band model for the v2 renderer.
 *
 * The band occupies the last committed content's trailing rows; committed history lives above it in
 * the terminal's own scrollback. Each frame emits exactly one synchronized write: optional ledger
 * commits pushed in at band top, a bounded band update (incremental damage or full repaint), and a
 * single caret placement (plan §3). Cursor motion is tracked relative to band top so no frame
 * traverses committed history.
 */
export class Presenter {
	private readonly terminal: Terminal;
	private initialized = false;
	private bandHeight = 0;
	/** Cursor resting row relative to band top (0 = band top). */
	private restRow = 0;

	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}

	get previousBandHeight(): number {
		return this.bandHeight;
	}

	present(frame: PresentFrame): PresentResult {
		const commitLines = frame.commitLines ?? [];
		const height = Math.max(0, Math.trunc(frame.band.height));
		const heightChanged = this.initialized && height !== this.bandHeight;
		const mustRepaint =
			!this.initialized || commitLines.length > 0 || heightChanged || frame.band.damage === undefined;

		let buffer = SYNC_BEGIN;
		// 1. Move up to band top from the previous resting row.
		if (this.initialized && this.restRow > 0) buffer += `\x1b[${this.restRow}A`;
		buffer += "\r";

		// 2. Push committed history in at band top; the band below is redrawn afterwards.
		for (const line of commitLines) {
			buffer += `${CLEAR_LINE}${line}\r\n`;
		}

		if (mustRepaint) {
			buffer += this.repaintBand(frame.band, height);
		} else {
			buffer += this.applyDamage(frame.band.damage ?? []);
		}

		// 3. Sole caret placement + DECTCEM policy.
		buffer += this.placeCursor(frame.caret, frame.showCursor ?? false, height);

		buffer += SYNC_END;
		this.bandHeight = height;
		this.initialized = true;
		this.terminal.write(buffer);
		return { bytes: buffer, fullRepaint: mustRepaint };
	}

	/** Full band repaint. Clears vacated rows when the band shrinks. Leaves the cursor at band bottom. */
	private repaintBand(band: PresentBand, height: number): string {
		const rows = band.repaint ?? [];
		let buffer = "";
		for (let row = 0; row < height; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += CLEAR_LINE + (rows[row] ?? "");
		}
		// Clear rows the shrunk band no longer occupies, then return to band bottom.
		const vacated = Math.max(0, this.bandHeight - height);
		if (vacated > 0) {
			for (let i = 0; i < vacated; i++) buffer += `\r\n${CLEAR_LINE}`;
			buffer += `\x1b[${vacated}A`;
		}
		this.restRow = Math.max(0, height - 1);
		return buffer;
	}

	/**
	 * Incremental band update: reposition to each run and overwrite exactly its columns. The cursor
	 * has already been moved to band top (row 0) by {@link present}, so runs are relative to row 0.
	 */
	private applyDamage(runs: readonly SerializedDamageRun[]): string {
		let buffer = "";
		let row = 0;
		for (const run of runs) {
			buffer += moveVertical(run.row - row);
			buffer += moveToColumn(run.column);
			buffer += run.text;
			row = run.row;
		}
		this.restRow = row;
		return buffer;
	}

	private placeCursor(caret: PresentCaret | undefined, showCursor: boolean, height: number): string {
		if (caret) {
			const targetRow = Math.max(0, Math.min(height - 1, Math.trunc(caret.row)));
			const targetCol = Math.max(0, Math.trunc(caret.column));
			let buffer = moveVertical(targetRow - this.restRow) + moveToColumn(targetCol);
			this.restRow = targetRow;
			buffer += showCursor ? SHOW_CURSOR : HIDE_CURSOR;
			return buffer;
		}
		// Park at band bottom-left and hide.
		const parkRow = Math.max(0, height - 1);
		const buffer = `${moveVertical(parkRow - this.restRow)}\r${HIDE_CURSOR}`;
		this.restRow = parkRow;
		return buffer;
	}

	/**
	 * Reset tracked geometry after an external clear/re-commit so the next frame repaints from the top.
	 * The caller owns emitting the clear sequence itself.
	 */
	markReset(): void {
		this.initialized = false;
		this.bandHeight = 0;
		this.restRow = 0;
	}

	/** Move the cursor below the band and restore visibility for terminal handback. */
	cleanup(): void {
		let buffer = "";
		const below = Math.max(0, this.bandHeight - 1 - this.restRow);
		buffer += moveVertical(below);
		buffer += "\r\n";
		buffer += SHOW_CURSOR;
		this.restRow = Math.max(0, this.bandHeight - 1);
		this.terminal.write(buffer);
	}
}
