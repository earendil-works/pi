// tmux key names as libghostty key presses: the bytes programs receive, in the terminal's current modes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Ghostty } from "../../plugins/terminals/ghostty.ts";
import { tmuxKey } from "../../plugins/terminals/keys.ts";

const ghostty = await Ghostty.load(
	await readFile(new URL("../../plugins/terminals/vendor/ghostty/ghostty-vt.wasm", import.meta.url)),
);

test("tmux key names encode as a terminal sends them; other words are text", () => {
	const vt = ghostty.terminal({ cols: 20, rows: 4, scrollback: 10 });
	const encode = (name: string) => {
		const key = tmuxKey(name);
		const bytes = key && vt.encodeKey(key);
		return bytes ? Buffer.from(bytes).toString("latin1") : undefined;
	};
	const expected: Record<string, string> = {
		Enter: "\r",
		Escape: "\x1b",
		"C-[": "\x1b",
		Tab: "\t",
		BTab: "\x1b[Z",
		BSpace: "\x7f",
		Space: " ",
		"C-c": "\x03",
		"C-C": "\x03",
		"^D": "\x04",
		"C-Space": "\x00",
		"C-\\": "\x1c",
		"C-_": "\x1f",
		"M-x": "\x1bx",
		"M-X": "\x1bX",
		Up: "\x1b[A",
		"S-Up": "\x1b[1;2A",
		Home: "\x1b[H",
		PPage: "\x1b[5~",
		DC: "\x1b[3~",
		F1: "\x1bOP",
		F5: "\x1b[15~",
	};
	for (const [name, bytes] of Object.entries(expected)) assert.equal(encode(name), bytes, name);
	// Not key names: tmux types them.
	for (const word of ["a", "npm test", "enter", "C-", "Ctrl-c", "x-y"]) assert.equal(tmuxKey(word), undefined, word);
	// Application cursor mode (a full-screen program asked for it) changes the arrows.
	vt.write(new TextEncoder().encode("\x1b[?1h"));
	assert.equal(encode("Up"), "\x1bOA");
	vt.free();
});
