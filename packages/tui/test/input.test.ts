import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.js";
import { getCursorAccentBgAnsi, getCursorAccentFgAnsi } from "../src/cursor.js";

describe("Input component", () => {
	it("renders an accent block cursor on a character", () => {
		const input = new Input();
		input.handleInput("a");
		input.handleInput("b");
		input.handleInput("c");
		input.handleInput("\x1b[D");

		const result = input.render(20).join("\n");

		assert.ok(result.includes(`${getCursorAccentFgAnsi()}${getCursorAccentBgAnsi()}c`));
		assert.ok(!result.includes("\x1b[7m"));
		assert.ok(!result.includes("\x1b[4m"));
	});

	it("renders an accent block cursor at end of line", () => {
		const input = new Input();
		input.handleInput("a");
		input.handleInput("b");
		input.handleInput("c");

		const result = input.render(20).join("\n");

		assert.ok(result.includes(`${getCursorAccentFgAnsi()}${getCursorAccentBgAnsi()} `));
		assert.ok(!result.includes("\x1b[7m"));
		assert.ok(!result.includes("\x1b[4m"));
	});
});
