import type { Terminal } from "../terminal.ts";
import { cellsToAnsi } from "./ansi.ts";
import { type BandGeometry, type BandHost, BandLayout, type StripSlot } from "./band.ts";
import { type Cell, CellBuffer, LinkTable } from "./cell-buffer.ts";
import { LedgerCommitQueue } from "./commit-queue.ts";
import { type FrameClock, FrameScheduler, systemFrameClock } from "./frame-scheduler.ts";
import { LedgerStore } from "./ledger.ts";
import { Presenter, type PresentResult, type SerializedDamageRun } from "./presenter.ts";
import { StyleTable } from "./styles.ts";

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
}

export interface RendererMetrics {
	readonly frames: number;
	readonly committedLines: number;
	readonly fullRepaints: number;
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
	private stopped = false;
	private metricsState: { frames: number; committedLines: number; fullRepaints: number } = {
		frames: 0,
		committedLines: 0,
		fullRepaints: 0,
	};

	constructor(options: LedgerBandRendererOptions<Theme>) {
		this.terminal = options.terminal;
		this.clock = options.clock ?? systemFrameClock;
		this.theme = options.theme;
		this.width = Math.max(1, Math.trunc(options.width ?? options.terminal.columns));
		this.viewportRows = Math.max(1, Math.trunc(options.viewportRows ?? options.terminal.rows));
		this.maxCommitLinesPerFrame = options.maxCommitLinesPerFrame ?? Number.POSITIVE_INFINITY;
		this.presenter = new Presenter(options.terminal);
		this.scheduler = new FrameScheduler((request) => this.render(request.now), this.clock, options.minimumIntervalMs);
	}

	get metrics(): RendererMetrics {
		return { ...this.metricsState };
	}

	/** BandHost: coalesce a frame. */
	requestFrame(force = false): void {
		if (this.stopped) return;
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
		this.theme = theme;
		// Committed history reflow is a re-commit trigger (step 6); here we repaint the live band.
		this.front = undefined;
		this.requestFrame(true);
	}

	resize(width: number, viewportRows: number): void {
		this.width = Math.max(1, Math.trunc(width));
		this.viewportRows = Math.max(1, Math.trunc(viewportRows));
		this.front = undefined;
		this.requestFrame(true);
	}

	/** Force any pending work to render synchronously and return the frame result, if one ran. */
	flush(): PresentResult | undefined {
		if (this.stopped) return undefined;
		this.scheduler.cancel();
		return this.render(this.clock.now());
	}

	private render(now: number): PresentResult {
		const commits = this.ledger.advance(this.width, this.theme);
		this.commitQueue.enqueue(commits, this.width);
		const flushed = this.commitQueue.flush(this.maxCommitLinesPerFrame);
		if (this.commitQueue.pending > 0) this.requestFrame();

		const geometry = this.bandLayout.layout(this.slots, this.width, this.viewportRows);
		const back = new CellBuffer(this.width, geometry.height, this.styles, this.links);
		for (const stripGeometry of geometry.strips) {
			if (stripGeometry.height <= 0) continue;
			const region = back.region(0, stripGeometry.y, this.width, stripGeometry.height);
			stripGeometry.slot.strip.paint(region, { now });
		}

		const heightChanged =
			this.front === undefined || this.front.height !== back.height || this.front.width !== back.width;
		const fullRepaint = flushed.length > 0 || heightChanged;
		const band = fullRepaint
			? { width: this.width, height: back.height, repaint: this.serializeRows(back) }
			: { width: this.width, height: back.height, damage: this.serializeDamage(back.diff(this.front)) };

		const caret = this.resolveCaret(geometry);
		const result = this.presenter.present({
			commitLines: flushed,
			band,
			caret,
			showCursor: caret !== undefined,
		});

		this.front = back;
		this.metricsState = {
			frames: this.metricsState.frames + 1,
			committedLines: this.metricsState.committedLines + flushed.length,
			fullRepaints: this.metricsState.fullRepaints + (result.fullRepaint ? 1 : 0),
		};
		return result;
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
		for (const cleanup of this.stripCleanups.values()) cleanup();
		this.stripCleanups.clear();
		this.slots.length = 0;
		this.presenter.cleanup();
	}
}
