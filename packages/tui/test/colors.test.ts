import assert from "node:assert";
import { describe, it } from "node:test";
import {
	colorToHex,
	colorToOkhsl,
	colorToRgb,
	indexedColor,
	okhslColor,
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

	it("parses and constructs OKHSL colors as sRGB", () => {
		// Full saturation at the red cusp is pure sRGB red; zero saturation is gray.
		assert.deepStrictEqual(parseColor("okhsl(29.23 100% 56.8%)"), rgbColor(255, 0, 0));
		assert.deepStrictEqual(parseColor("okhsl(120 0 0.5)"), okhslColor(120, 0, 0.5));
		assert.strictEqual(colorToHex(okhslColor(0, 0, 1)), "#ffffff");
		assert.strictEqual(colorToHex(okhslColor(250, 1, 0)), "#000000");
		assert.deepStrictEqual(parseColor("OKHSL(250deg 60% 55%)"), okhslColor(250, 0.6, 0.55));
		assert.throws(() => parseColor("okhsl(250 160% 55%)"), /s must be between 0 and 1/);
		assert.throws(() => okhslColor(250, 0.5, 1.5), /l must be between 0 and 1/);
	});

	it("round-trips colors through OKHSL", () => {
		for (const hex of ["#4f8eb3", "#e48a7a", "#eab65d", "#20242a", "#f8f9fa"]) {
			const { h, s, l } = colorToOkhsl(parseColor(hex));
			assert.strictEqual(colorToHex(okhslColor(h, s, l)), hex);
		}
		assert.deepStrictEqual(colorToOkhsl(rgbColor(128, 128, 128)).s, 0);
	});

	it("styles text and closes sequences in reverse order", () => {
		assert.strictEqual(
			styleText("Ready", { fg: rgbColor(18, 52, 86), bg: indexedColor(9), bold: true, italic: true }, "truecolor"),
			"\x1b[38;2;18;52;86m\x1b[48;5;9m\x1b[1m\x1b[3mReady\x1b[23m\x1b[22m\x1b[49m\x1b[39m",
		);
		assert.match(styleText("Ready", { fg: rgbColor(18, 52, 86) }, "256color"), /^\x1b\[38;5;\d+mReady\x1b\[39m$/);
	});
});
