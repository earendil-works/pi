import { getKeybindings } from "../keybindings.ts";
import { CURSOR_MARKER, TUI } from "../tui.ts";
import { ansiToStyledLine } from "./ansi-parse.ts";
import { type HistorySource, HistoryViewer } from "./history-viewer.ts";
import type { StyledLine } from "./styles.ts";

/** Terminal renderer selection. `v1` is the differential whole-tree renderer; `v2` is the Ledger+Band host. */
export type TuiRenderMode = "v1" | "v2";

/**
 * v2 Ledger+Band terminal host.
 *
 * Subclasses the concrete {@link TUI} class so extension factory callbacks that receive a `TUI`
 * (setWidget/setFooter/setHeader/custom/setEditorComponent) keep working unchanged (plan §7). The
 * v2 render pipeline (Ledger frontier, Band layout, Presenter commits) is layered on top of the
 * inherited overlay/focus/input machinery in later Phase-B steps rather than by branching v1's
 * whole-tree `render(width)` / `doRender()` path (plan §1).
 *
 * What this host adds today is the in-Pi full-history affordance (plan §6): it wires the
 * {@link HistoryViewer} pager into the inherited lifecycle so a real `pi --tui v2` session can open,
 * navigate, and close a browsable view of its complete retained transcript — including rows scrolled
 * past the emulator's native scrollback tail — reachable by the configurable `tui.history.open` key
 * (default `ctrl+r`). The live transcript keeps rendering through the inherited v1 pipeline; the pager
 * is a self-contained alt-screen overlay, so opening it saves the primary screen and its scrollback
 * and closing it restores them untouched. While the pager owns the terminal, v1 rendering is
 * suspended (nothing writes onto the alt screen) and genuine terminal resizes are forwarded to the
 * pager so it reflows; exiting resumes v1 with a full repaint to return-to-live.
 */
export class V2TUIHost extends TUI {
	readonly renderMode: TuiRenderMode = "v2";
	private historyViewer: HistoryViewer | undefined;
	private removeHistoryInput: (() => void) | undefined;
	private viewerSize = { columns: 0, rows: 0 };

	override start(): void {
		super.start();
		// Capture input ahead of the focused editor so the open key and, once open, every pager key are
		// handled here. Re-registering on each start() (e.g. resume after ctrl+z) drops the prior listener.
		this.removeHistoryInput?.();
		this.removeHistoryInput = this.addInputListener((data) => this.routeHistoryInput(data));
	}

	/** True while the alt-screen full-history pager owns the terminal and v1 rendering is suspended. */
	get historyOpen(): boolean {
		return this.historyViewer !== undefined;
	}

	private routeHistoryInput(data: string): { consume: boolean } | undefined {
		if (this.historyViewer) {
			// Modal while open: every sequence drives the pager so keystrokes never reach the editor beneath.
			this.historyViewer.handleInput(data);
			return { consume: true };
		}
		if (getKeybindings().matches(data, "tui.history.open")) {
			this.openHistory();
			return { consume: true };
		}
		return undefined;
	}

	/**
	 * Open the alt-screen full-history pager over the complete retained transcript (plan §6). Idempotent
	 * while already open. Band/v1 painting is suspended for the pager's lifetime so nothing corrupts the
	 * alternate screen it now owns.
	 */
	openHistory(): void {
		if (this.historyViewer) return;
		const columns = this.terminal.columns;
		const rows = this.terminal.rows;
		this.viewerSize = { columns, rows };
		const source: HistorySource = { historyLines: (width) => this.snapshotHistory(width) };
		this.historyViewer = new HistoryViewer({
			terminal: this.terminal,
			source,
			width: columns,
			rows,
			keybindings: getKeybindings(),
			onExit: () => this.onHistoryExit(),
		});
		this.suspendRendering();
		this.historyViewer.openViewer();
	}

	/**
	 * Snapshot the complete retained component tree (the full session transcript, including rows scrolled
	 * past the emulator's native tail) as styled lines reflowed at `width`. Re-rendering per width gives
	 * the pager correct reflow on resize. The zero-width cursor marker is stripped so it never reaches the
	 * viewer's cells; §3 control-sanitization still applies when the viewer serializes each row.
	 */
	private snapshotHistory(width: number): StyledLine[] {
		return this.render(width).map((raw) =>
			ansiToStyledLine(raw.includes(CURSOR_MARKER) ? raw.split(CURSOR_MARKER).join("") : raw),
		);
	}

	/** Return-to-live: the alt screen restored the saved primary screen; force a full v1 repaint. */
	private onHistoryExit(): void {
		this.historyViewer = undefined;
		this.resumeRendering();
	}

	override requestRender(force = false): void {
		if (this.historyViewer) {
			// The pager owns the terminal and v1 stays suspended; forward genuine resizes so it reflows.
			const columns = this.terminal.columns;
			const rows = this.terminal.rows;
			if (columns !== this.viewerSize.columns || rows !== this.viewerSize.rows) {
				this.viewerSize = { columns, rows };
				this.historyViewer.resize(columns, rows);
			}
			return;
		}
		super.requestRender(force);
	}

	override stop(): void {
		if (this.removeHistoryInput) {
			this.removeHistoryInput();
			this.removeHistoryInput = undefined;
		}
		if (this.historyViewer) {
			// Restore the primary screen before terminal handback. Clearing the field first makes the
			// viewer's onExit resume-repaint a no-op — the following super.stop() owns the final handback.
			const viewer = this.historyViewer;
			this.historyViewer = undefined;
			viewer.close();
		}
		super.stop();
	}
}
