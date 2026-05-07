/**
 * Tests for Editor newline input behaviors.
 *
 * Covers Shift+Enter, Ctrl+Enter, \+Enter workaround, and the
 * "empty editor Enter → newline" fallback for terminals without
 * Shift+Enter support (方案 C).
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

function createTestEditor(options?: { disableSubmit?: boolean }): Editor {
	const editor = new Editor(createTestTUI(), defaultEditorTheme);
	if (options?.disableSubmit) editor.disableSubmit = true;
	return editor;
}

describe("Newline input", () => {
	it("should insert newline on Shift+Enter via modifyOtherKeys", () => {
		const editor = createTestEditor();
		editor.handleInput("h");
		editor.handleInput("i");
		editor.handleInput("\x1b[27;2;13~"); // modifyOtherKeys Shift+Enter
		assert.strictEqual(editor.getText(), "hi\n");
	});

	it("should insert newline on Ctrl+Enter via modifyOtherKeys", () => {
		const editor = createTestEditor();
		editor.handleInput("h");
		editor.handleInput("\x1b[27;5;13~"); // modifyOtherKeys Ctrl+Enter (modValue=5 → modifier=4=Ctrl)
		assert.strictEqual(editor.getText(), "h\n");
	});

	it("should insert newline on Ctrl+Enter via Kitty protocol", () => {
		const editor = createTestEditor();
		editor.handleInput("h");
		editor.handleInput("\x1b[13;5u"); // Kitty CSI-u Ctrl+Enter (modValue=5 → modifier=4=Ctrl)
		assert.strictEqual(editor.getText(), "h\n");
	});

	it("should insert newline on \\+Enter workaround", () => {
		const editor = createTestEditor();
		editor.handleInput("h");
		editor.handleInput("\\");
		editor.handleInput("\r"); // Enter → detects \ before cursor → newline
		assert.strictEqual(editor.getText(), "h\n");
	});

	it("should NOT submit on \\+Enter workaround (first char is \\)", () => {
		const editor = createTestEditor();
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.handleInput("\\");
		editor.handleInput("\r");
		assert.strictEqual(submitted, "");
		assert.strictEqual(editor.getText(), "\n");
	});

	it("should submit on plain Enter with content", () => {
		const editor = createTestEditor();
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.handleInput("h");
		editor.handleInput("i");
		editor.handleInput("\r");
		assert.strictEqual(submitted, "hi");
	});

	// ====== 方案 C：空编辑器 Enter 换行 ======

	it("should insert newline on Enter when editor is empty", () => {
		const editor = createTestEditor();
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.handleInput("\r"); // Enter on empty editor
		assert.strictEqual(submitted, ""); // 不应提交
		assert.strictEqual(editor.getText(), "\n"); // 应换行
	});

	it("should submit on Enter when editor has content", () => {
		const editor = createTestEditor();
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.handleInput("h");
		editor.handleInput("\r"); // Enter with content → submit
		assert.strictEqual(submitted, "h");
	});

	it("should submit on Enter after inserting newline and adding content", () => {
		// Simulate: empty editor → Enter newline → type content → Enter submit
		const editor = createTestEditor();
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};

		editor.handleInput("\r"); // Empty editor Enter → newline
		assert.strictEqual(editor.getText(), "\n");

		editor.handleInput("x"); // Type on second line
		editor.handleInput("\r"); // Has content → submit
		assert.strictEqual(submitted.trim(), "x");
	});

	it("should submit empty text on double Enter in empty editor", () => {
		const editor = createTestEditor();
		let submitted: string | null = null;
		editor.onSubmit = (text) => {
			submitted = text;
		};

		editor.handleInput("\r"); // Empty → newline ("\n")
		editor.handleInput("\r"); // Non-empty → submitValue
		// submitValue trims → ""
		assert.strictEqual(submitted, "");
		assert.strictEqual(editor.getText(), ""); // submitValue clears editor
	});

	it("should NOT insert newline on Enter when disableSubmit=true and editor is empty", () => {
		const editor = createTestEditor({ disableSubmit: true });
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};

		editor.handleInput("\r"); // disableSubmit → return
		assert.strictEqual(submitted, "");
		assert.strictEqual(editor.getText(), ""); // Editor still empty
	});
});
