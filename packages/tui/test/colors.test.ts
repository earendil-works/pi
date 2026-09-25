import assert from "node:assert";
import { describe, it } from "node:test";
import {
	colorToOklch,
	colorToRgb,
	indexedColor,
	maxOklchChroma,
	oklchColor,
	parseColor,
	rgbColor,
	styleText,
} from "../src/index.ts";

describe("colors", () => {
	it("parses hex and OKLCH colors and rejects everything else", () => {
		assert.deepStrictEqual(parseColor("#abc"), { kind: "rgb", r: 170, g: 187, b: 204 });
		assert.deepStrictEqual(parseColor("oklch(62% 0.1 200)"), { kind: "oklch", l: 0.62, c: 0.1, h: 200 });
		assert.throws(() => parseColor(""), /Invalid color value/);
		assert.throws(() => parseColor("red"), /Invalid color value/);
	});

	it("gamut-maps OKLCH to sRGB, including the lightness limits", () => {
		assert.deepStrictEqual(colorToRgb(oklchColor(0.627955, 0.257683, 29.2339)), { r: 255, g: 0, b: 0 });
		assert.deepStrictEqual(colorToRgb(oklchColor(1, 0.3, 150)), { r: 255, g: 255, b: 255 });
		assert.deepStrictEqual(colorToRgb(oklchColor(0, 0.3, 150)), { r: 0, g: 0, b: 0 });
	});

	it("finds the largest in-gamut OKLCH chroma for a lightness and hue", () => {
		// Pure sRGB red sits on the gamut boundary.
		const red = colorToOklch(rgbColor(255, 0, 0));
		assert.ok(Math.abs(maxOklchChroma(red.l, red.h) - red.c) < 0.002);
		// The gamut narrows toward black and white, and differs by hue.
		assert.strictEqual(maxOklchChroma(0, 90), 0);
		assert.strictEqual(maxOklchChroma(1, 90), 0);
		assert.ok(maxOklchChroma(0.9, 110) > maxOklchChroma(0.9, 265));
		assert.ok(maxOklchChroma(0.4, 265) > maxOklchChroma(0.4, 110));
		// Gamut mapping an out-of-gamut color lands on the same maximum.
		const chroma = maxOklchChroma(0.7, 150);
		const { r, g, b } = colorToRgb(oklchColor(0.7, chroma * 2, 150));
		assert.ok(Math.abs(colorToOklch(rgbColor(r, g, b)).c - chroma) < 0.01);
	});

	it("styles text and closes sequences in reverse order", () => {
		assert.strictEqual(
			styleText("Ready", { fg: rgbColor(18, 52, 86), bg: indexedColor(9), bold: true, italic: true }, "truecolor"),
			"\x1b[38;2;18;52;86m\x1b[48;5;9m\x1b[1m\x1b[3mReady\x1b[23m\x1b[22m\x1b[49m\x1b[39m",
		);
		assert.match(styleText("Ready", { fg: rgbColor(18, 52, 86) }, "256color"), /^\x1b\[38;5;\d+mReady\x1b\[39m$/);
	});
});
