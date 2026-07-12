import type { PaintRegion, Strip } from "./band.ts";
import type { FocusedCaret } from "./renderer.ts";
import { Signal } from "./signal.ts";
import { DEFAULT_TEXT_STYLE, type StyledLine } from "./styles.ts";
import { DefaultTextLayout, type TextLayout } from "./text-layout.ts";
import { TextModel } from "./text-model.ts";

/**
 * A focusable band {@link Strip} that resolves the renderer's SOLE caret CUP (plan §3 single-caret
 * policy). The strip never paints a cursor cell; when focused it reports a band-local caret cell that
 * the owner feeds to `LedgerBandRenderer.setFocusedCaret`, so exactly one hardware caret is placed per
 * frame and only for the focused strip.
 */
export interface CaretStrip extends Strip {
	readonly id: string;
	focused: boolean;
	/** Band-local caret for the single-caret policy, or undefined when this strip is not focused. */
	caret(width: number): FocusedCaret | undefined;
}

/**
 * Native v2 editor strip built on the Phase-A TextModel/TextLayout primitives (plan §7). Editing is
 * driven through {@link model}; the strip re-lays-out and repaints on model changes and derives its
 * caret purely from {@link TextLayout} — no CURSOR_MARKER round-trip. The caret is delivered to the
 * renderer's single-caret policy via {@link caret}; the painted band carries only text, never a cursor
 * cell, so the renderer's one hardware CUP is the only caret on screen.
 */
export class EditorStrip implements CaretStrip {
	readonly onDirty = new Signal<void>();
	readonly onLayoutDirty = new Signal<void>();
	readonly id: string;
	readonly model: TextModel;
	focused = false;
	private readonly layout: TextLayout;
	private modelSubscription: (() => void) | undefined;

	constructor(id: string, model: TextModel = new TextModel(), layout: TextLayout = new DefaultTextLayout()) {
		this.id = id;
		this.model = model;
		this.layout = layout;
		// A model edit can change the wrapped line count, so relayout (which also repaints) the band.
		this.modelSubscription = this.model.onChange.subscribe(() => this.onLayoutDirty.emit());
	}

	measure(width: number): number {
		return this.layout.wrap(this.model, width).length;
	}

	paint(region: PaintRegion): void {
		const lines = this.layout.wrap(this.model, region.width);
		for (let row = 0; row < lines.length && row < region.height; row++) {
			const text = lines[row]!.text;
			const styled: StyledLine = text.length === 0 ? [] : [{ text, style: DEFAULT_TEXT_STYLE }];
			region.putText(0, row, styled);
		}
	}

	caret(width: number): FocusedCaret | undefined {
		if (!this.focused) return undefined;
		const cell = this.layout.caretCell(this.model, width);
		return { stripId: this.id, row: cell.row, column: cell.column, visible: true };
	}

	unmount(): void {
		this.modelSubscription?.();
		this.modelSubscription = undefined;
	}
}
