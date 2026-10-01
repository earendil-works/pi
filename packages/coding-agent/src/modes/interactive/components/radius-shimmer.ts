import { type Color, foregroundAnsi, mixColors, parseColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** The four colors of the Radius logo, in the order they stream across the text. */
const RADIUS_COLORS: readonly Color[] = ["#4d9abf", "#83ccd2", "#f1be57", "#f09082"].map((hex) => parseColor(hex));
/** Width of each color band, in characters. */
const CHARS_PER_COLOR = 4;
const CHARS_PER_SECOND = 10;

/**
 * Color `text` with the Radius logo colors flowing left to right. `elapsedMs` is the animation time;
 * the pattern repeats every `RADIUS_COLORS.length * CHARS_PER_COLOR` characters.
 */
export function radiusShimmer(text: string, elapsedMs: number): string {
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
