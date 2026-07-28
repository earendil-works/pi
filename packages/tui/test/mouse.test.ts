import assert from "node:assert";
import { describe, it } from "node:test";
import { parseMouseInput } from "../src/mouse.ts";

describe("parseMouseInput", () => {
	it("parses left-button presses with zero-based coordinates", () => {
		assert.deepStrictEqual(parseMouseInput("\x1b[<0;4;3M"), {
			type: "press",
			button: "left",
			x: 3,
			y: 2,
			shift: false,
			alt: false,
			ctrl: false,
		});
	});

	it("parses releases and modifiers", () => {
		assert.deepStrictEqual(parseMouseInput("\x1b[<28;7;9m"), {
			type: "release",
			button: "left",
			x: 6,
			y: 8,
			shift: true,
			alt: true,
			ctrl: true,
		});
	});

	it("parses wheel directions", () => {
		assert.deepStrictEqual(parseMouseInput("\x1b[<64;2;5M"), {
			type: "wheel",
			direction: "up",
			x: 1,
			y: 4,
			shift: false,
			alt: false,
			ctrl: false,
		});
		const wheelDown = parseMouseInput("\x1b[<65;2;5M");
		assert.strictEqual(wheelDown?.type, "wheel");
		if (wheelDown?.type === "wheel") assert.strictEqual(wheelDown.direction, "down");
	});

	it("ignores unsupported horizontal wheel input", () => {
		assert.strictEqual(parseMouseInput("\x1b[<66;2;5M"), undefined);
		assert.strictEqual(parseMouseInput("\x1b[<67;2;5M"), undefined);
	});

	it("ignores non-mouse input", () => {
		assert.strictEqual(parseMouseInput("hello"), undefined);
	});
});
