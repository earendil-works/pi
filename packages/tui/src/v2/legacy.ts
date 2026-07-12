import type { Component } from "../tui.ts";
import { ansiToStyledLine, ansiToStyledLines } from "./ansi-parse.ts";
import type { PaintRegion, Strip } from "./band.ts";
import type { BlockRenderer } from "./ledger.ts";
import { Signal } from "./signal.ts";
import type { StyledLine } from "./styles.ts";

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
