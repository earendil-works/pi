import assert from "node:assert";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, theme } from "./theme.js";

type Rgb = { r: number; g: number; b: number };

function parseRgbAnsi(ansi: string, prefix: 38 | 48): Rgb {
	const match = ansi.match(new RegExp(`\\x1b\\[${prefix};2;(\\d+);(\\d+);(\\d+)m`));
	assert.ok(match, `Expected truecolor ANSI for prefix ${prefix}, got: ${JSON.stringify(ansi)}`);
	return {
		r: Number.parseInt(match[1]!, 10),
		g: Number.parseInt(match[2]!, 10),
		b: Number.parseInt(match[3]!, 10),
	};
}

function srgbChannelToLinear(channel: number): number {
	const normalized = channel / 255;
	return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb): number {
	return (
		0.2126 * srgbChannelToLinear(rgb.r) + 0.7152 * srgbChannelToLinear(rgb.g) + 0.0722 * srgbChannelToLinear(rgb.b)
	);
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
	const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
	const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
	return (lighter + 0.05) / (darker + 0.05);
}

beforeAll(() => {
	process.env.COLORTERM = "truecolor";
	initTheme("nerv");
});

describe("nerv theme", () => {
	it("uses the darker #111113 card background for user and tool surfaces", () => {
		const expected = { r: 17, g: 17, b: 19 };

		expect(parseRgbAnsi(theme.getBgAnsi("userMessageBg"), 48)).toEqual(expected);
		expect(parseRgbAnsi(theme.getBgAnsi("toolPendingBg"), 48)).toEqual(expected);
		expect(parseRgbAnsi(theme.getBgAnsi("toolSuccessBg"), 48)).toEqual(expected);
		expect(parseRgbAnsi(theme.getBgAnsi("toolErrorBg"), 48)).toEqual(expected);
	});

	it("keeps readable contrast for user and tool text on those surfaces", () => {
		const userBg = parseRgbAnsi(theme.getBgAnsi("userMessageBg"), 48);
		const pendingBg = parseRgbAnsi(theme.getBgAnsi("toolPendingBg"), 48);
		const successBg = parseRgbAnsi(theme.getBgAnsi("toolSuccessBg"), 48);
		const errorBg = parseRgbAnsi(theme.getBgAnsi("toolErrorBg"), 48);

		expect(contrastRatio(parseRgbAnsi(theme.getFgAnsi("userMessageText"), 38), userBg)).toBeGreaterThan(7);
		expect(contrastRatio(parseRgbAnsi(theme.getFgAnsi("toolTitle"), 38), pendingBg)).toBeGreaterThan(7);
		expect(contrastRatio(parseRgbAnsi(theme.getFgAnsi("toolOutput"), 38), pendingBg)).toBeGreaterThan(4.5);
		expect(contrastRatio(parseRgbAnsi(theme.getFgAnsi("success"), 38), successBg)).toBeGreaterThan(4.5);
		expect(contrastRatio(parseRgbAnsi(theme.getFgAnsi("error"), 38), errorBg)).toBeGreaterThan(4.5);
	});
});
