import assert from "node:assert";
import { describe, it } from "node:test";
import { styledLineToAnsi } from "../src/v2/ansi.ts";
import { ansiToStyledLines } from "../src/v2/ansi-parse.ts";
import { DEFAULT_TEXT_STYLE } from "../src/v2/styles.ts";

describe("ansiToStyledLines", () => {
	it("parses plain text into a single default-styled span", () => {
		assert.deepStrictEqual(ansiToStyledLines("hello"), [[{ text: "hello", style: DEFAULT_TEXT_STYLE }]]);
	});

	it("splits on newlines and preserves trailing empty lines", () => {
		const lines = ansiToStyledLines("a\nb\n");
		assert.deepStrictEqual(
			lines.map((line) => line.map((span) => span.text).join("")),
			["a", "b", ""],
		);
	});

	it("decodes SGR attributes and colors", () => {
		const [line] = ansiToStyledLines("\x1b[1;38;2;255;0;0mred\x1b[0m plain");
		assert.strictEqual(line!.length, 2);
		assert.strictEqual(line![0]!.text, "red");
		assert.strictEqual(line![0]!.style.bold, true);
		assert.deepStrictEqual(line![0]!.style.foreground, { kind: "rgb", red: 255, green: 0, blue: 0 });
		assert.strictEqual(line![1]!.text, " plain");
		assert.strictEqual(line![1]!.style.bold, false);
	});

	it("decodes indexed colors in both palettes", () => {
		const [line] = ansiToStyledLines("\x1b[33ma\x1b[93mb\x1b[48;5;240mc");
		assert.deepStrictEqual(line![0]!.style.foreground, { kind: "indexed", index: 3 });
		assert.deepStrictEqual(line![1]!.style.foreground, { kind: "indexed", index: 11 });
		assert.deepStrictEqual(line![2]!.style.background, { kind: "indexed", index: 240 });
	});

	it("decodes OSC-8 hyperlinks and closes them", () => {
		const [line] = ansiToStyledLines("\x1b]8;;https://a\x07link\x1b]8;;\x07 after");
		assert.strictEqual(line![0]!.text, "link");
		assert.strictEqual(line![0]!.link, "https://a");
		assert.strictEqual(line![1]!.text, " after");
		assert.strictEqual(line![1]!.link, undefined);
	});

	it("carries style across hard newlines", () => {
		const lines = ansiToStyledLines("\x1b[1mbold\nstill");
		assert.strictEqual(lines[0]![0]!.style.bold, true);
		assert.strictEqual(lines[1]![0]!.style.bold, true);
	});

	it("drops non-SGR control sequences", () => {
		const [line] = ansiToStyledLines("a\x1b[2Kb\x1b[Hc");
		assert.strictEqual(line!.map((span) => span.text).join(""), "abc");
	});

	it("round-trips serializer output back to the same lines", () => {
		const original = ansiToStyledLines("\x1b[1;3mstyled\x1b[0m and \x1b]8;;https://x\x07linked\x1b]8;;\x07");
		const reparsed = ansiToStyledLines(original.map((line) => styledLineToAnsi(line)).join("\n"));
		assert.deepStrictEqual(reparsed, original);
	});
});
