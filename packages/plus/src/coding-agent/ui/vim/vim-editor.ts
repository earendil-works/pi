// Ported (core subset) from pi-vimmode (MIT, (c) 2026 pekochan069, /Users/kangtong/Documents/x/pi-vimmode).
// The Pi adapter: a CustomEditor subclass that runs the pure modal engine and applies
// its effects through Pi's own editor/keybindings. Cursor movement is expressed as
// terminal input sequences Pi already understands, so user keymaps keep working.

import { CustomEditor } from "../../../../../coding-agent/src/modes/interactive/components/index.ts";
import { createModalState, handleModalInput } from "./engine.ts";
import { fitStatusBorder, renderVisualRows, statusParts } from "./render.ts";
import type { AdapterCommand, EditorSnapshot, ModalEffect, Position, VimMode } from "./types.ts";

const KEY = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	lineStart: "\x01",
	lineEnd: "\x05",
	wordLeft: "\x1bb",
	wordRight: "\x1bf",
	undo: "\x1f",
} as const satisfies Record<Exclude<AdapterCommand, "redo">, string>;

type RedoSnapshot = { text: string; cursor: Position };

export class VimEditor extends CustomEditor {
	private modal = createModalState("insert");
	private redoStack: RedoSnapshot[] = [];
	private visualScrollOffset = 0;

	getVimMode(): VimMode {
		return this.modal.mode;
	}

	/** Exposed for tests: the modal state (register, last search, ...). */
	getModalState() {
		return this.modal;
	}

	override handleInput(data: string): void {
		const snapshot = this.snapshot();
		const result = handleModalInput(this.modal, snapshot, data);
		this.modal = result.state;
		this.applyEffects(result.effects);
	}

	override render(width: number): string[] {
		const inVisual =
			(this.modal.mode === "visual" || this.modal.mode === "visualLine") && this.modal.visualAnchor !== undefined;
		let lines: string[];
		if (inVisual && this.modal.visualAnchor) {
			const rendered = renderVisualRows({
				lines: this.getLines(),
				cursor: this.getCursor(),
				anchor: this.modal.visualAnchor,
				mode: this.modal.mode as "visual" | "visualLine",
				width,
				terminalRows: this.terminalRows() ?? 24,
				focused: this.focused,
				scrollOffset: this.visualScrollOffset,
				borderColor: (text) => this.borderColor(text),
			});
			this.visualScrollOffset = rendered.scrollOffset;
			lines = rendered.rows;
		} else {
			this.visualScrollOffset = 0;
			lines = super.render(width);
		}
		if (lines.length === 0 || width <= 0) return lines;

		const status = statusParts(this.modal, {
			text: this.getText(),
			lines: this.getLines(),
			cursor: this.getCursor(),
		});
		const statusLine = fitStatusBorder(status.left, status.right, width, (text) => this.borderColor(text));
		if (this.isShowingAutocomplete()) lines.push(statusLine);
		else lines[lines.length - 1] = statusLine;
		return lines;
	}

	private snapshot(): EditorSnapshot {
		return {
			text: this.getText(),
			lines: this.getLines(),
			cursor: this.getCursor(),
			isAutocompleteOpen: this.isShowingAutocomplete(),
		};
	}

	private applyEffects(effects: ModalEffect[]): void {
		for (const effect of effects) this.applyEffect(effect);
	}

	private applyEffect(effect: ModalEffect): void {
		switch (effect.type) {
			case "delegate": {
				const before = this.redoSnapshot();
				super.handleInput(effect.input);
				this.clearRedoAfterTextChange(before);
				return;
			}
			case "adapterCommand":
				this.applyAdapterCommand(effect.command);
				return;
			case "edit":
				this.applyEdit(effect.result.text, effect.result.cursor);
				this.redoStack = [];
				return;
			case "restoreCursor":
				this.restoreCursor(effect.position);
				return;
			case "invalidate":
				this.tui.requestRender();
				return;
		}
	}

	private applyAdapterCommand(command: AdapterCommand): void {
		if (command === "undo") {
			const before = this.redoSnapshot();
			super.handleInput(KEY.undo);
			const after = this.redoSnapshot();
			if (
				after.text !== before.text ||
				after.cursor.line !== before.cursor.line ||
				after.cursor.col !== before.cursor.col
			) {
				this.redoStack.push(before);
			}
			return;
		}
		if (command === "redo") {
			const snapshot = this.redoStack.pop();
			if (!snapshot) {
				this.tui.requestRender();
				return;
			}
			this.applyEdit(snapshot.text, snapshot.cursor);
			this.tui.requestRender();
			return;
		}
		super.handleInput(KEY[command]);
	}

	private applyEdit(text: string, cursor: Position): void {
		this.setText(text);
		this.restoreCursor(cursor);
		this.tui.requestRender();
	}

	private redoSnapshot(): RedoSnapshot {
		return { text: this.getText(), cursor: this.getCursor() };
	}

	private clearRedoAfterTextChange(before: RedoSnapshot): void {
		if (this.getText() !== before.text) this.redoStack = [];
	}

	/**
	 * Move the hardware cursor to an absolute position using only terminal input:
	 * line start + vertical arrows, then the shorter of start+N×right / end+N×left.
	 */
	private restoreCursor(position: Position): void {
		const lines = this.getLines();
		const target = {
			line: Math.max(0, Math.min(position.line, lines.length - 1)),
			col: Math.max(0, Math.min(position.col, lines[position.line]?.length ?? 0)),
		};
		const current = this.getCursor();

		if (current.line > target.line) {
			super.handleInput(KEY.lineStart);
			for (let line = current.line; line > target.line; line--) super.handleInput(KEY.up);
		} else if (current.line < target.line) {
			super.handleInput(KEY.lineStart);
			for (let line = current.line; line < target.line; line++) super.handleInput(KEY.down);
		}

		const lineLength = lines[target.line]?.length ?? 0;
		const fromStart = target.col;
		const fromEnd = lineLength - target.col;
		const [boundaryKey, movementKey, distance] =
			fromStart <= fromEnd ? [KEY.lineStart, KEY.right, fromStart] : [KEY.lineEnd, KEY.left, fromEnd];
		super.handleInput(boundaryKey);
		for (let index = 0; index < distance; index++) super.handleInput(movementKey);
	}

	private terminalRows(): number | undefined {
		const rows = (this.tui as unknown as { terminal?: { rows?: unknown } }).terminal?.rows;
		return typeof rows === "number" ? rows : undefined;
	}
}
