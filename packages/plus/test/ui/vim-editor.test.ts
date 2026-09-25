// Headless tests for the VimEditor adapter: drives handleInput with raw terminal
// input sequences and asserts buffer/cursor state plus the status border.

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { KeybindingsManager } from "../../../coding-agent/src/core/keybindings.ts";
import { VimEditor } from "../../src/coding-agent/ui/vim/vim-editor.ts";

const theme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};

function createEditor(): VimEditor {
	const fakeTui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI;
	return new VimEditor(fakeTui, theme, new KeybindingsManager());
}

/** Enter normal mode with the cursor at the start of the buffer. */
function toNormal(editor: VimEditor): void {
	editor.handleInput("\x1b"); // insert -> normal (cursor steps left)
	editor.handleInput("0"); // jump to column 0
}

function statusLine(editor: VimEditor, width = 80): string {
	const rows = editor.render(width);
	return stripVTControlCharacters(rows[rows.length - 1] ?? "");
}

describe("VimEditor", () => {
	it("starts in insert mode and shows -- INSERT --", () => {
		const editor = createEditor();
		editor.handleInput("hello");
		assert.equal(editor.getText(), "hello");
		assert.equal(editor.getVimMode(), "insert");
		assert.match(statusLine(editor), /-- INSERT --/);
	});

	it("Esc switches to normal mode and steps the cursor left", () => {
		const editor = createEditor();
		editor.handleInput("hello");
		editor.handleInput("\x1b");
		assert.equal(editor.getVimMode(), "normal");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
		assert.match(statusLine(editor), /-- NORMAL --/);
	});

	it("normal-mode motions move the cursor through the adapter", () => {
		const editor = createEditor();
		editor.setText("foo bar");
		toNormal(editor);
		editor.handleInput("w");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
		editor.handleInput("b");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		editor.handleInput("$");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 7 });
	});

	it("x deletes the char under the cursor; u undoes; Ctrl-r redoes", () => {
		const editor = createEditor();
		editor.setText("hello");
		toNormal(editor);
		editor.handleInput("x");
		assert.equal(editor.getText(), "ello");
		editor.handleInput("u");
		assert.equal(editor.getText(), "hello");
		editor.handleInput("\x12"); // ctrl+r
		assert.equal(editor.getText(), "ello");
	});

	it("dd yanks the line linewise and p pastes it below", () => {
		const editor = createEditor();
		editor.setText("one\ntwo");
		toNormal(editor); // cursor lands on line 1 ("two")
		editor.handleInput("d");
		editor.handleInput("d");
		assert.equal(editor.getText(), "one");
		editor.handleInput("p");
		assert.equal(editor.getText(), "one\ntwo");
	});

	it("search jumps to the match and n wraps", () => {
		const editor = createEditor();
		editor.setText("ab cd ab");
		toNormal(editor);
		for (const key of ["/", "a", "b", "\r"]) editor.handleInput(key);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
		editor.handleInput("n"); // wraps back to col 0
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("pending search shows the query in the status border", () => {
		const editor = createEditor();
		editor.setText("foo");
		toNormal(editor);
		editor.handleInput("/");
		editor.handleInput("f");
		assert.match(statusLine(editor), /\/f/);
	});

	it("insert entries: a appends after the cursor, o opens a line below", () => {
		const editor = createEditor();
		editor.setText("hi");
		toNormal(editor);
		editor.handleInput("$");
		editor.handleInput("a");
		assert.equal(editor.getVimMode(), "insert");
		editor.handleInput("!");
		assert.equal(editor.getText(), "hi!");
		editor.handleInput("\x1b");
		editor.handleInput("o");
		assert.equal(editor.getText(), "hi!\n");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
	});

	it("enter is delegated to Pi (submit) in normal mode", () => {
		const editor = createEditor();
		let submitted = false;
		editor.onSubmit = () => {
			submitted = true;
		};
		editor.setText("ab");
		toNormal(editor);
		editor.handleInput("\r");
		assert.equal(submitted, true);
		assert.equal(editor.getText(), ""); // Pi clears the editor on submit
	});

	it("visual mode d deletes the selection", () => {
		const editor = createEditor();
		editor.setText("hello world");
		toNormal(editor);
		editor.handleInput("v");
		assert.equal(editor.getVimMode(), "visual");
		editor.handleInput("e");
		editor.handleInput("d");
		assert.equal(editor.getText(), " world");
		assert.equal(editor.getVimMode(), "normal");
	});

	it("J joins lines", () => {
		const editor = createEditor();
		editor.setText("foo\nbar");
		toNormal(editor);
		editor.handleInput("k");
		editor.handleInput("J");
		assert.equal(editor.getText(), "foo bar");
	});
});
