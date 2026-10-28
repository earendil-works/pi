/**
 * The `/login` menu with the animated "Sign in with Radius" option. Internal to the interactive mode: the shimmer
 * is Radius-only and is not exposed to other selectors.
 */

import { type Color, foregroundAnsi, mixColors, parseColor, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { ExtensionSelectorComponent } from "./extension-selector.ts";

/** The four colors of the Radius logo, in the order they stream across the text. */
const RADIUS_COLORS: readonly Color[] = ["#4d9abf", "#83ccd2", "#f1be57", "#f09082"].map((hex) => parseColor(hex));
/** Width of each color band, in characters. */
const CHARS_PER_COLOR = 4;
const CHARS_PER_SECOND = 10;
const ANIMATION_FRAME_MS = 50;

/** Color `text` with the Radius logo colors flowing left to right; `elapsedMs` is the animation time. */
function radiusShimmer(text: string, elapsedMs: number): string {
	const mode = theme.getColorMode();
	const cycle = RADIUS_COLORS.length * CHARS_PER_COLOR;
	const offset = (elapsedMs / 1000) * CHARS_PER_SECOND;
	let result = "";
	let index = 0;
	for (const char of text) {
		const position = (((index - offset) % cycle) + cycle) % cycle;
		const band = Math.floor(position / CHARS_PER_COLOR);
		const t = position / CHARS_PER_COLOR - band;
		// Smoothstep keeps each band recognizable while still blending into the next one.
		const amount = t * t * (3 - 2 * t);
		const from = RADIUS_COLORS[band] as Color;
		const to = RADIUS_COLORS[(band + 1) % RADIUS_COLORS.length] as Color;
		result += foregroundAnsi(mixColors(from, to, amount, "srgb"), mode) + char;
		index++;
	}
	return `${result}\x1b[39m`;
}

/** The "Sign in with Radius" option: `label` is the full option, starting with the animated `text`. */
type RadiusOption = { label: string; text: string };

/**
 * Swaps the line `ExtensionSelectorComponent` draws for the selected Radius option with the animated one. When the
 * selector's row style changes or the label wraps, the line no longer matches and the option renders normally.
 */
class RadiusLoginMenuComponent extends ExtensionSelectorComponent {
	private readonly radiusOption: RadiusOption;
	private readonly animationStart = performance.now();
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private animating = false;

	constructor(
		tui: TUI,
		title: string,
		options: string[],
		radiusOption: RadiusOption,
		onSelect: (option: string) => void,
		onCancel: () => void,
	) {
		super(
			title,
			options,
			(option) => {
				this.stopAnimation();
				onSelect(option);
			},
			() => {
				this.stopAnimation();
				onCancel();
			},
		);
		this.radiusOption = radiusOption;
		this.animationTimer = setInterval(() => {
			if (this.animating) tui.requestRender();
		}, ANIMATION_FRAME_MS);
		this.animationTimer.unref?.();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const { label, text } = this.radiusOption;
		const selectedLine = new Text(theme.fg("accent", "→ ") + theme.fg("accent", label), 1, 0).render(width)[0];
		const index = selectedLine === undefined ? -1 : lines.indexOf(selectedLine);
		this.animating = index >= 0;
		if (this.animating) {
			const shimmer = radiusShimmer(text, performance.now() - this.animationStart);
			const animatedLine = theme.fg("accent", "→ ") + shimmer + label.slice(text.length);
			lines[index] = new Text(animatedLine, 1, 0).render(width)[0] ?? "";
		}
		return lines;
	}

	private stopAnimation(): void {
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
		this.animating = false;
	}

	override dispose(): void {
		this.stopAnimation();
		super.dispose();
	}
}

/** Top-level `/login` selector whose Radius option shimmers in the Radius logo colors while it is selected. */
export function createLoginMenuSelector(
	tui: TUI,
	title: string,
	options: string[],
	radiusOption: RadiusOption,
	onSelect: (option: string) => void,
	onCancel: () => void,
): ExtensionSelectorComponent {
	return new RadiusLoginMenuComponent(tui, title, options, radiusOption, onSelect, onCancel);
}
