import { getKeybindings, type KeybindingsManager } from "../keybindings.ts";
import type { Terminal } from "../terminal.ts";
import { cellsToAnsi, hardWrapStyledLine, styledLineToAnsi } from "./ansi.ts";
import { type BandGeometry, type BandHost, BandLayout, type StripSlot } from "./band.ts";
import { type Cell, CellBuffer, LinkTable } from "./cell-buffer.ts";
import { LedgerCommitQueue } from "./commit-queue.ts";
import { type FrameClock, FrameScheduler, systemFrameClock } from "./frame-scheduler.ts";
import { type HistorySource, HistoryViewer } from "./history-viewer.ts";
import type { LedgerCommit } from "./ledger.ts";
import { LedgerStore } from "./ledger.ts";
import { Presenter, type PresentReset, type PresentResult, type SerializedDamageRun } from "./presenter.ts";
import { DEFAULT_TEXT_STYLE, type StyledLine, StyleTable } from "./styles.ts";

export interface FocusedCaret {
	readonly stripId: string;
	readonly row: number;
	readonly column: number;
	readonly visible: boolean;
}

export interface LedgerBandRendererOptions<Theme> {
	readonly terminal: Terminal;
	readonly theme: Theme;
	readonly width?: number;
	readonly viewportRows?: number;
	readonly clock?: FrameClock;
	readonly minimumIntervalMs?: number;
	/** Maximum committed lines written per frame; the rest are carried to the next frame. */
	readonly maxCommitLinesPerFrame?: number;
	/** Maximum committed lines physically replayed into scrollback on re-commit; older rows collapse into an earlier-history marker. */
	readonly maxReplayLines?: number;
	/** Maximum replay rows written per physical frame; the rest are carried to the next frame so re-commit replay is chunked (plan §6). Defaults to unbounded (single-frame replay). */
	readonly maxReplayLinesPerFrame?: number;
	/** Affordance hint appended to the earlier-history marker (e.g. a keybinding to open the full-history viewer). */
	readonly historyHint?: string;
	/** Keybinding registry used to open/drive the full-history viewer; defaults to the global registry. */
	readonly keybindings?: KeybindingsManager;
}

export interface RendererMetrics {
	readonly frames: number;
	readonly committedLines: number;
	readonly fullRepaints: number;
	readonly recommits: number;
	/** Physically replayed vs. omitted committed lines from the most recent re-commit. */
	readonly lastReplay: { readonly replayed: number; readonly omitted: number } | undefined;
}

function isBlankCell(cell: Cell): boolean {
	return cell.cluster === " " && cell.styleId === 0 && cell.linkId === 0;
}

/**
 * Composes the Phase-A primitives and the Presenter into the exact seven-step frame order from the
 * Phase B plan (§2): advance the ledger frontier, lay out and paint the band, diff against the front
 * buffer, and perform one synchronized Presenter write. No frame path traverses committed history;
 * every band repaint is O(viewport).
 */
export class LedgerBandRenderer<Theme> implements BandHost {
	readonly ledger: LedgerStore<Theme> = new LedgerStore<Theme>();
	private readonly terminal: Terminal;
	private readonly clock: FrameClock;
	private readonly scheduler: FrameScheduler;
	private readonly commitQueue = new LedgerCommitQueue();
	private readonly presenter: Presenter;
	private readonly bandLayout = new BandLayout();
	private readonly styles = new StyleTable();
	private readonly links = new LinkTable();
	private readonly slots: StripSlot[] = [];
	private readonly stripCleanups = new Map<string, () => void>();
	private front: CellBuffer | undefined;
	private theme: Theme;
	private width: number;
	private viewportRows: number;
	private focusedCaret: FocusedCaret | undefined;
	private readonly maxCommitLinesPerFrame: number;
	private readonly maxReplayLines: number;
	private readonly maxReplayLinesPerFrame: number;
	private readonly historyHint: string;
	private readonly keybindings: KeybindingsManager;
	/** Active full-history viewer (plan §6). While set, band frames are suspended and the alt screen owns the terminal. */
	private historyViewer: HistoryViewer | undefined;
	/** True while the alt-screen history viewer owns the terminal; the band produces no frames until it closes. */
	private suspended = false;
	private recommitNeeded = false;
	/** Monotonic re-commit epoch. Bumped when a re-commit begins so a superseded chunked replay is discarded (plan §6). */
	private epoch = 0;
	/** In-flight chunked replay: the epoch that owns it and the retained rows not yet physically written. */
	private replay: { readonly epoch: number; remaining: string[] } | undefined;
	private stopped = false;
	private metricsState: RendererMetrics = {
		frames: 0,
		committedLines: 0,
		fullRepaints: 0,
		recommits: 0,
		lastReplay: undefined,
	};

	constructor(options: LedgerBandRendererOptions<Theme>) {
		this.terminal = options.terminal;
		this.clock = options.clock ?? systemFrameClock;
		this.theme = options.theme;
		this.width = Math.max(1, Math.trunc(options.width ?? options.terminal.columns));
		this.viewportRows = Math.max(1, Math.trunc(options.viewportRows ?? options.terminal.rows));
		this.maxCommitLinesPerFrame = options.maxCommitLinesPerFrame ?? Number.POSITIVE_INFINITY;
		this.maxReplayLines = options.maxReplayLines ?? Number.POSITIVE_INFINITY;
		this.maxReplayLinesPerFrame = options.maxReplayLinesPerFrame ?? Number.POSITIVE_INFINITY;
		this.historyHint = options.historyHint ?? "";
		this.keybindings = options.keybindings ?? getKeybindings();
		this.presenter = new Presenter(options.terminal);
		this.scheduler = new FrameScheduler((request) => this.render(request.now), this.clock, options.minimumIntervalMs);
	}

	get metrics(): RendererMetrics {
		return { ...this.metricsState };
	}

	/** True while a chunked re-commit replay still has rows to write on subsequent frames (plan §6). */
	get replayInProgress(): boolean {
		return this.replay !== undefined;
	}

	/** True while the alt-screen full-history viewer is open and owns the terminal (plan §6). */
	get historyOpen(): boolean {
		return this.historyViewer !== undefined;
	}

	/**
	 * Route one input sequence for the full-history affordance (plan §6). While the viewer is open, all
	 * input drives it; otherwise the configured open key (`tui.history.open`) opens it. Returns true when
	 * the key was consumed so the host can fall through to its own bindings when it was not.
	 */
	handleKey(data: string): boolean {
		if (this.stopped) return false;
		if (this.historyViewer) {
			this.historyViewer.handleInput(data);
			return true;
		}
		if (this.keybindings.matches(data, "tui.history.open")) {
			this.openHistory();
			return true;
		}
		return false;
	}

	/**
	 * Open the alt-screen full-history viewer over the Ledger's complete logical history (plan §6). Band
	 * frames are suspended while it owns the terminal; the primary screen and its scrollback are saved by
	 * `CSI ?1049h` and restored untouched on close.
	 */
	openHistory(): void {
		if (this.stopped || this.historyViewer) return;
		this.suspended = true;
		this.scheduler.cancel();
		const source: HistorySource = { historyLines: (width) => this.ledger.snapshot(width, this.theme) };
		const viewer = new HistoryViewer({
			terminal: this.terminal,
			source,
			width: this.width,
			rows: this.viewportRows,
			keybindings: this.keybindings,
			onExit: () => this.onHistoryExit(),
		});
		this.historyViewer = viewer;
		viewer.openViewer();
	}

	/** Return-to-live after the viewer exits: resume band frames and force a full repaint of the restored primary screen. */
	private onHistoryExit(): void {
		this.historyViewer = undefined;
		this.suspended = false;
		if (this.stopped) return;
		// The alt screen restored the saved primary screen; force a full band repaint so the live band and
		// its sole caret are re-established (a pending width/theme re-commit, if any, replays here instead).
		this.front = undefined;
		this.requestFrame(true);
	}

	/** BandHost: coalesce a frame. */
	requestFrame(force = false): void {
		if (this.stopped || this.suspended) return;
		this.scheduler.requestFrame(force);
	}

	/** BandHost: run `callback` on a recurring interval driven by the frame clock. Returns a canceller. */
	scheduleAnimation(callback: () => void, intervalMs: number): () => void {
		let cancelled = false;
		let handle: unknown;
		const tick = (): void => {
			if (cancelled || this.stopped) return;
			callback();
			handle = this.clock.setTimeout(tick, intervalMs);
		};
		handle = this.clock.setTimeout(tick, Math.max(0, intervalMs));
		return () => {
			cancelled = true;
			if (handle !== undefined) this.clock.clearTimeout(handle);
		};
	}

	addStrip(slot: StripSlot): void {
		if (this.stripCleanups.has(slot.id)) throw new Error(`Duplicate band strip id: ${slot.id}`);
		this.slots.push(slot);
		const offDirty = slot.strip.onDirty.subscribe(() => this.requestFrame());
		const offLayout = slot.strip.onLayoutDirty.subscribe(() => this.requestFrame(true));
		this.stripCleanups.set(slot.id, () => {
			offDirty();
			offLayout();
			slot.strip.unmount?.();
		});
		slot.strip.mount?.(this);
		this.requestFrame(true);
	}

	removeStrip(id: string): void {
		const cleanup = this.stripCleanups.get(id);
		if (!cleanup) return;
		cleanup();
		this.stripCleanups.delete(id);
		const index = this.slots.findIndex((slot) => slot.id === id);
		if (index !== -1) this.slots.splice(index, 1);
		this.requestFrame(true);
	}

	setFocusedCaret(caret: FocusedCaret | undefined): void {
		this.focusedCaret = caret;
		this.requestFrame();
	}

	setTheme(theme: Theme): void {
		if (Object.is(theme, this.theme)) return;
		this.theme = theme;
		// Theme epoch change reflows committed history: schedule a re-commit (plan §6).
		this.recommitNeeded = true;
		this.requestFrame(true);
	}

	resize(width: number, viewportRows: number): void {
		const nextWidth = Math.max(1, Math.trunc(width));
		const nextRows = Math.max(1, Math.trunc(viewportRows));
		const widthChanged = nextWidth !== this.width;
		this.width = nextWidth;
		this.viewportRows = nextRows;
		// A width epoch change reflows committed history and requires a re-commit; a rows-only change
		// just relayouts the band. Reset the front buffer so the band fully repaints either way.
		this.front = undefined;
		if (widthChanged) this.recommitNeeded = true;
		this.historyViewer?.resize(this.width, this.viewportRows);
		this.requestFrame(true);
	}

	/** Force a re-commit on the next frame (compaction, history rebuild, committed edit, SIGCONT handback). */
	requestRecommit(): void {
		this.recommitNeeded = true;
		this.requestFrame(true);
	}

	/**
	 * Force the next pending frame to render synchronously and return its result, if one ran. A chunked
	 * re-commit replay advances exactly one chunk per call; drive it to completion by looping while
	 * {@link replayInProgress} (the frame scheduler does this automatically in production).
	 */
	flush(): PresentResult | undefined {
		if (this.stopped || this.suspended) return undefined;
		this.scheduler.cancel();
		return this.render(this.clock.now());
	}

	private render(now: number): PresentResult {
		// Epoch guard #1 (pre-compute): a pending re-commit supersedes any in-flight replay before a chunk
		// is computed, so a stale-epoch chunk is never even built.
		if (this.recommitNeeded) {
			this.recommitNeeded = false;
			return this.beginRecommit(now);
		}
		if (this.replay) return this.continueReplay(now);

		const commits = this.ledger.advance(this.width, this.theme);
		this.commitQueue.enqueue(commits, this.width);
		const flushed = this.commitQueue.flush(this.maxCommitLinesPerFrame);
		if (this.commitQueue.pending > 0) this.requestFrame();

		const { geometry, back } = this.paintBand(now);
		const heightChanged =
			this.front === undefined || this.front.height !== back.height || this.front.width !== back.width;
		const fullRepaint = flushed.length > 0 || heightChanged;
		const band = fullRepaint
			? { width: this.width, height: back.height, repaint: this.serializeRows(back) }
			: { width: this.width, height: back.height, damage: this.serializeDamage(back.diff(this.front)) };

		const caret = this.resolveCaret(geometry);
		const result = this.presenter.present({ commitLines: flushed, band, caret, showCursor: caret !== undefined });

		this.front = back;
		this.metricsState = {
			...this.metricsState,
			frames: this.metricsState.frames + 1,
			committedLines: this.metricsState.committedLines + flushed.length,
			fullRepaints: this.metricsState.fullRepaints + (result.fullRepaint ? 1 : 0),
		};
		return result;
	}

	/**
	 * Begin a re-commit (plan §6): open a new epoch, snapshot the replay watermark, and emit the first
	 * chunk. Clears the screen and terminal scrollback, then replays the committed logical history
	 * reflowed at the current width/theme. The replay is capped to `maxReplayLines` (older rows collapse
	 * into a single earlier-history marker, never splitting an atomic multi-row block) and chunked to
	 * `maxReplayLinesPerFrame` rows per physical frame. `resetCommitState` re-anchors the Ledger frontier
	 * to the watermark so post-watermark commits stay logically pending until replay drains; it never
	 * discards block models or state. Cancellation drops only not-yet-written physical rows: a newer
	 * width/theme epoch re-snapshots from the latest logical state on the next frame.
	 */
	private beginRecommit(now: number): PresentResult {
		const epoch = ++this.epoch;
		// Discard only physical work from any superseded replay; the Ledger snapshot below is authoritative.
		this.replay = undefined;
		this.commitQueue.flush(); // discard any stale-width serialized lines
		this.ledger.resetCommitState();
		const units = this.buildReplayUnits(this.ledger.advance(this.width, this.theme));
		const { rows, omitted } = this.capReplay(units);
		if (omitted > 0) rows.unshift(styledLineToAnsi(this.earlierHistoryMarker(omitted)));

		const chunk = this.nextChunk(rows);
		const remaining = rows.slice(chunk.length);
		this.replay = remaining.length > 0 ? { epoch, remaining } : undefined;

		this.metricsState = {
			...this.metricsState,
			recommits: this.metricsState.recommits + 1,
			lastReplay: { replayed: rows.length, omitted },
		};
		const result = this.presentReplayChunk(now, chunk, { scrollback: true });
		if (this.replay) this.requestFrame();
		return result;
	}

	/** Emit the next replay chunk for the current epoch. No reset: chunks push into scrollback above the band. */
	private continueReplay(now: number): PresentResult {
		const replay = this.replay!;
		// Epoch guard #2 (dispatch): a superseded epoch must never write after the new clear. render() routes
		// a pending re-commit before reaching here, so this is a belt-and-braces assertion of the invariant.
		if (replay.epoch !== this.epoch) {
			this.replay = undefined;
			return this.render(now);
		}
		const chunk = this.nextChunk(replay.remaining);
		replay.remaining = replay.remaining.slice(chunk.length);
		if (replay.remaining.length === 0) this.replay = undefined;
		else this.requestFrame();
		return this.presentReplayChunk(now, chunk, undefined);
	}

	/** One self-contained replay frame: paint a coherent band, place the sole caret, and present a single synchronized write. */
	private presentReplayChunk(now: number, commitLines: string[], reset: PresentReset | undefined): PresentResult {
		const { geometry, back } = this.paintBand(now);
		const caret = this.resolveCaret(geometry);
		const result = this.presenter.present({
			reset,
			commitLines,
			band: { width: this.width, height: back.height, repaint: this.serializeRows(back) },
			caret,
			showCursor: caret !== undefined,
		});
		this.front = back;
		this.metricsState = {
			...this.metricsState,
			frames: this.metricsState.frames + 1,
			committedLines: this.metricsState.committedLines + commitLines.length,
			fullRepaints: this.metricsState.fullRepaints + (result.fullRepaint ? 1 : 0),
		};
		return result;
	}

	/** Serialize each block's reflowed rows once (plan §3 choke point), preserving block boundaries for the cap. */
	private buildReplayUnits(commits: readonly LedgerCommit[]): { readonly atomic: boolean; rows: string[] }[] {
		return commits.map((commit) => {
			const rows: string[] = [];
			for (const line of commit.lines) {
				for (const visual of hardWrapStyledLine(line, this.width)) rows.push(styledLineToAnsi(visual));
			}
			return { atomic: commit.atomic ?? false, rows };
		});
	}

	/**
	 * Select the capped replay tail. Rows are dropped oldest-first until the total fits `maxReplayLines`;
	 * a non-atomic block sheds individual head rows, but an atomic block (e.g. an image + reserved rows)
	 * is included or omitted whole so the cap never splits it (plan §6).
	 */
	private capReplay(units: { readonly atomic: boolean; rows: string[] }[]): { rows: string[]; omitted: number } {
		let total = 0;
		for (const unit of units) total += unit.rows.length;
		if (!Number.isFinite(this.maxReplayLines) || total <= this.maxReplayLines) {
			return { rows: units.flatMap((unit) => unit.rows), omitted: 0 };
		}
		const cap = Math.max(0, Math.trunc(this.maxReplayLines));
		const kept = units.map((unit) => ({ atomic: unit.atomic, rows: unit.rows.slice() }));
		let omitted = 0;
		for (const unit of kept) {
			if (total <= cap) break;
			if (unit.rows.length === 0) continue;
			if (unit.atomic) {
				omitted += unit.rows.length;
				total -= unit.rows.length;
				unit.rows = [];
			} else {
				const drop = Math.min(total - cap, unit.rows.length);
				unit.rows.splice(0, drop);
				omitted += drop;
				total -= drop;
			}
		}
		return { rows: kept.flatMap((unit) => unit.rows), omitted };
	}

	/** First `maxReplayLinesPerFrame` rows for this frame (all of them when unbounded), at least one to guarantee progress. */
	private nextChunk(rows: readonly string[]): string[] {
		if (!Number.isFinite(this.maxReplayLinesPerFrame)) return rows.slice();
		return rows.slice(0, Math.max(1, Math.trunc(this.maxReplayLinesPerFrame)));
	}

	private paintBand(now: number): { geometry: BandGeometry; back: CellBuffer } {
		const geometry = this.bandLayout.layout(this.slots, this.width, this.viewportRows);
		const back = new CellBuffer(this.width, geometry.height, this.styles, this.links);
		for (const stripGeometry of geometry.strips) {
			if (stripGeometry.height <= 0) continue;
			const region = back.region(0, stripGeometry.y, this.width, stripGeometry.height);
			stripGeometry.slot.strip.paint(region, { now });
		}
		return { geometry, back };
	}

	private earlierHistoryMarker(omitted: number): StyledLine {
		const plural = omitted === 1 ? "" : "s";
		const hint = this.historyHint ? ` — ${this.historyHint}` : "";
		return [
			{ text: `… ${omitted} earlier line${plural} not shown${hint}`, style: { ...DEFAULT_TEXT_STYLE, dim: true } },
		];
	}

	private resolveCaret(geometry: BandGeometry): { row: number; column: number } | undefined {
		if (!this.focusedCaret || !this.focusedCaret.visible) return undefined;
		const stripGeometry = geometry.strips.find((entry) => entry.slot.id === this.focusedCaret?.stripId);
		if (!stripGeometry || stripGeometry.height <= 0) return undefined;
		const localRow = Math.max(0, Math.min(stripGeometry.height - 1, Math.trunc(this.focusedCaret.row)));
		return { row: stripGeometry.y + localRow, column: Math.max(0, Math.trunc(this.focusedCaret.column)) };
	}

	private serializeDamage(
		runs: readonly { row: number; column: number; cells: readonly Cell[] }[],
	): SerializedDamageRun[] {
		return runs.map((run) => ({
			row: run.row,
			column: run.column,
			text: cellsToAnsi(run.cells, this.styles, this.links),
		}));
	}

	private serializeRows(buffer: CellBuffer): string[] {
		const rows: string[] = [];
		for (let row = 0; row < buffer.height; row++) {
			let last = -1;
			for (let column = 0; column < buffer.width; column++) {
				if (!isBlankCell(buffer.get(row, column))) last = column;
			}
			if (last < 0) {
				rows.push("");
				continue;
			}
			const cells: Cell[] = [];
			for (let column = 0; column <= last; column++) cells.push(buffer.get(row, column));
			rows.push(cellsToAnsi(cells, buffer.styles, buffer.links));
		}
		return rows;
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.scheduler.cancel();
		// Restore the primary screen if the alt-screen viewer is still open, before terminal handback.
		this.historyViewer?.close();
		this.historyViewer = undefined;
		this.suspended = false;
		for (const cleanup of this.stripCleanups.values()) cleanup();
		this.stripCleanups.clear();
		this.slots.length = 0;
		this.presenter.cleanup();
	}
}
