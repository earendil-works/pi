import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import { ansiToStyledLine, ansiToStyledLines } from "./ansi-parse.ts";
import type { PaintRegion, Strip } from "./band.ts";
import type { CaretStrip } from "./editor-strip.ts";
import type { BlockRenderer } from "./ledger.ts";
import type { FocusedCaret } from "./renderer.ts";
import { Signal } from "./signal.ts";
import type { StyledLine } from "./styles.ts";
import type { CaretCell } from "./text-layout.ts";

/**
 * Adapts a v1 `Component` (which renders to ANSI strings) into a v2 band `Strip`.
 *
 * The component is rendered and parsed to structured spans only when its width changes or the owner
 * calls {@link invalidate}, mirroring v1's cache-until-invalidate discipline (plan §7). Painting clips
 * to the assigned region via a metric — `CellRegion` silently drops out-of-bounds cells rather than
 * throwing — so an over-wide legacy line never crashes a frame. Painted cells reach the wire through
 * the band's normal cell serializer (`cellsToAnsi`), so legacy content is control-sanitized there like
 * all other content (plan §3).
 */
export class LegacyStripAdapter implements Strip {
	readonly onDirty = new Signal<void>();
	readonly onLayoutDirty = new Signal<void>();
	private readonly component: Component;
	private cache: { width: number; lines: StyledLine[] } | undefined;

	constructor(component: Component) {
		this.component = component;
	}

	private ensure(width: number): StyledLine[] {
		if (this.cache && this.cache.width === width) return this.cache.lines;
		// Each v1 render() element is one physical line and is self-contained (resets its own SGR state).
		const lines = this.component.render(width).map((line) => ansiToStyledLine(line));
		this.cache = { width, lines };
		return lines;
	}

	measure(width: number): number {
		return this.ensure(width).length;
	}

	paint(region: PaintRegion): void {
		const lines = this.ensure(region.width);
		for (let row = 0; row < lines.length && row < region.height; row++) {
			region.putText(0, row, lines[row]!);
		}
	}

	/**
	 * Drop the cache and re-render on the next frame, mirroring v1 `Component.invalidate`. Emits
	 * layout-dirty because a legacy component's line count can change between renders.
	 */
	invalidate(): void {
		this.cache = undefined;
		this.component.invalidate();
		this.onLayoutDirty.emit();
	}

	/** Signal a content-only change (same height) so the band repaints without a relayout. */
	touch(): void {
		this.cache = undefined;
		this.onDirty.emit();
	}
}

/**
 * Adapts a pure v1 block render function (model -> ANSI string) into a v2 {@link BlockRenderer}
 * producing structured styled lines, so existing message/tool/diff renderers feed the ledger
 * unchanged (plan §7). A single trailing newline is dropped to match the ledger's completed-line
 * convention. The parsed lines re-enter the frame through the ledger's normal serializer path
 * ({@link styledLineToAnsi}), so any control bytes surviving the ANSI parse are stripped there like
 * all other content (plan §3).
 */
export class LegacyBlockRendererAdapter<Model, Theme> implements BlockRenderer<Model, Theme> {
	private readonly renderModel: (model: Model, width: number, theme: Theme) => string;

	constructor(render: (model: Model, width: number, theme: Theme) => string) {
		this.renderModel = render;
	}

	render(model: Model, width: number, theme: Theme): StyledLine[] {
		const output = this.renderModel(model, width, theme);
		return ansiToStyledLines(output.endsWith("\n") ? output.slice(0, -1) : output);
	}
}

/**
 * Adapts a v1 focusable editor `Component` (which emits {@link CURSOR_MARKER} at its cursor when
 * focused) into a v2 {@link CaretStrip} (plan §7). The marker is a v1-only boundary artifact: this
 * adapter derives the caret cell from it ONCE, at render time, then strips every occurrence before the
 * line is parsed to cells — so the marker can never reach painted cells or serialized bytes. (The §3
 * serializer would strip its control bytes anyway, but the boundary removal also keeps the marker's
 * printable `_pi:c` payload out of the visible frame.) The caret is delivered to the renderer's
 * single-caret policy via {@link caret}; toggling {@link focused} drives whether the wrapped component
 * emits the marker at all.
 */
export class LegacyEditorStripAdapter implements CaretStrip {
	readonly onDirty = new Signal<void>();
	readonly onLayoutDirty = new Signal<void>();
	readonly id: string;
	private readonly component: Component & Focusable;
	private cache: { width: number; lines: StyledLine[]; caret: CaretCell | undefined } | undefined;

	constructor(id: string, component: Component & Focusable) {
		this.id = id;
		this.component = component;
	}

	get focused(): boolean {
		return this.component.focused;
	}

	set focused(value: boolean) {
		if (this.component.focused === value) return;
		this.component.focused = value;
		// Focus toggles whether the v1 component emits the marker, so the cached caret/lines are stale.
		this.cache = undefined;
		this.onDirty.emit();
	}

	private ensure(width: number): { width: number; lines: StyledLine[]; caret: CaretCell | undefined } {
		if (this.cache && this.cache.width === width) return this.cache;
		let caret: CaretCell | undefined;
		const lines = this.component.render(width).map((raw, row) => {
			const markerIndex = raw.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1 && caret === undefined) {
				// Column is the visible width before the marker; visibleWidth ignores SGR and the marker.
				caret = { row, column: visibleWidth(raw.slice(0, markerIndex)) };
			}
			const clean = markerIndex === -1 ? raw : raw.split(CURSOR_MARKER).join("");
			return ansiToStyledLine(clean);
		});
		this.cache = { width, lines, caret };
		return this.cache;
	}

	measure(width: number): number {
		return this.ensure(width).lines.length;
	}

	paint(region: PaintRegion): void {
		const { lines } = this.ensure(region.width);
		for (let row = 0; row < lines.length && row < region.height; row++) region.putText(0, row, lines[row]!);
	}

	caret(width: number): FocusedCaret | undefined {
		const cell = this.ensure(width).caret;
		if (!this.component.focused || !cell) return undefined;
		return { stripId: this.id, row: cell.row, column: cell.column, visible: true };
	}

	/** Drop the cache and re-render on the next frame, mirroring v1 `Component.invalidate`. */
	invalidate(): void {
		this.cache = undefined;
		this.component.invalidate();
		this.onLayoutDirty.emit();
	}
}
