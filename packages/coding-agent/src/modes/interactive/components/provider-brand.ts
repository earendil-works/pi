/**
 * Animated brand styles for the names of preferred partner providers in selectors: Radius shimmers in its logo
 * colors and OpenRouter glows in its brand color. Selectors apply them to the selected row only.
 */

import { type Color, foregroundAnsi, mixColors, parseColor, type TUI } from "@earendil-works/pi-tui";
import { RADIUS_PROVIDER_ID } from "../../../core/radius.ts";
import { theme } from "../theme/theme.ts";

/** Colors `text` for animation time `elapsedMs`. */
export type ProviderBrandStyle = (text: string, elapsedMs: number) => string;

/** The animated style of a provider's name, or `undefined` when the provider has none. */
export function getProviderBrandStyle(providerId: string): ProviderBrandStyle | undefined {
	if (providerId === RADIUS_PROVIDER_ID) return radiusShimmer;
	if (providerId === "openrouter") return openRouterGlow;
	return undefined;
}

/** The four colors of the Radius logo, in the order they stream across the text. */
const RADIUS_COLORS: readonly Color[] = ["#4d9abf", "#83ccd2", "#f1be57", "#f09082"].map((hex) => parseColor(hex));
/** Width of each color band, in characters. */
const CHARS_PER_COLOR = 4;
const CHARS_PER_SECOND = 10;

/** Colors `text` with the Radius logo colors flowing left to right. */
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

/**
 * OpenRouter's brand colors per theme appearance: lime on dark backgrounds, violet on light ones, where lime would
 * be unreadable. The glow breathes between `base` and the brighter `peak`.
 */
const OPENROUTER_GLOW = {
	dark: { base: parseColor("#c6f243"), peak: parseColor("#efffb0") },
	light: { base: parseColor("#5d32e1"), peak: parseColor("#8f6bff") },
} as const;
const GLOW_PERIOD_MS = 2400;

/** Colors `text` in OpenRouter's brand color, slowly brightening and dimming. */
function openRouterGlow(text: string, elapsedMs: number): string {
	const { base, peak } = OPENROUTER_GLOW[theme.appearance];
	const amount = (1 - Math.cos((2 * Math.PI * elapsedMs) / GLOW_PERIOD_MS)) / 2;
	return `${foregroundAnsi(mixColors(base, peak, amount, "oklch"), theme.getColorMode())}${text}\x1b[39m`;
}

const ANIMATION_FRAME_MS = 50;

/** Re-renders `tui` every animation frame while `isAnimating()` holds; returns the function that stops it. */
export function startBrandAnimation(tui: TUI, isAnimating: () => boolean): () => void {
	const timer = setInterval(() => {
		if (isAnimating()) tui.requestRender();
	}, ANIMATION_FRAME_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}
