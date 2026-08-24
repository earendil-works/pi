import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

function tempImage(): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-image-marker-"));
	const path = join(dir, "img.png");
	writeFileSync(path, "png");
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("Editor image markers", () => {
	it("inserts and tracks an image marker", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const image = tempImage();
		try {
			editor.setText("hello ");
			const id = editor.insertImageMarker(image.path);
			assert.strictEqual(editor.getText(), "hello [Image 1]");
			assert.deepStrictEqual(editor.getImageAttachments(), [{ id, path: image.path }]);
		} finally {
			image.cleanup();
		}
	});

	it("moves across the marker as one unit", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const image = tempImage();
		try {
			editor.insertImageMarker(image.path);
			editor.handleInput("\x1b[D");
			assert.strictEqual(editor.getCursor().col, 0);
			editor.handleInput("\x1b[C");
			assert.strictEqual(editor.getCursor().col, "[Image 1]".length);
		} finally {
			image.cleanup();
		}
	});

	for (const [name, keys] of [
		["backspace", ["\x7f"]],
		["forward delete", ["\x1b[H", "\x1b[3~"]],
		["delete to line start", ["\x15"]],
		["delete to line end", ["\x1b[H", "\x0b"]],
		["delete word backward", ["\x17"]],
		["delete word forward", ["\x1b[H", "\x1bd"]],
	] as const) {
		it(`${name} removes the attachment with the marker`, () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const image = tempImage();
			try {
				editor.insertImageMarker(image.path);
				for (const key of keys) editor.handleInput(key);
				assert.strictEqual(editor.getText(), "");
				assert.deepStrictEqual(editor.getImageAttachments(), []);
			} finally {
				image.cleanup();
			}
		});
	}

	it("undoing insertion removes the attachment with the marker", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const image = tempImage();
		try {
			editor.insertImageMarker(image.path);
			editor.handleInput("\x1b[45;5u");
			assert.strictEqual(editor.getText(), "");
			assert.deepStrictEqual(editor.getImageAttachments(), []);
		} finally {
			image.cleanup();
		}
	});

	it("undoing deletion restores the attachment with the marker", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const image = tempImage();
		try {
			const id = editor.insertImageMarker(image.path);
			editor.handleInput("\x7f");
			editor.handleInput("\x1b[45;5u");
			assert.strictEqual(editor.getText(), `[Image ${id}]`);
			assert.deepStrictEqual(editor.getImageAttachments(), [{ id, path: image.path }]);
		} finally {
			image.cleanup();
		}
	});

	it("returns attachments in marker position order", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const first = tempImage();
		const second = tempImage();
		try {
			const firstId = editor.insertImageMarker(first.path);
			editor.handleInput("\x1b[H");
			const secondId = editor.insertImageMarker(second.path);
			assert.strictEqual(editor.getText(), `[Image ${secondId}][Image ${firstId}]`);
			assert.deepStrictEqual(editor.getImageAttachments(), [
				{ id: secondId, path: second.path },
				{ id: firstId, path: first.path },
			]);
		} finally {
			first.cleanup();
			second.cleanup();
		}
	});

	it("clearImages drops attachments", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const image = tempImage();
		try {
			editor.insertImageMarker(image.path);
			editor.clearImages();
			assert.deepStrictEqual(editor.getImageAttachments(), []);
		} finally {
			image.cleanup();
		}
	});
});
