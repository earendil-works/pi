import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor, getKeybindings, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { PromptContentPreview } from "../src/modes/interactive/components/prompt-content-preview.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const block = "  first\nsecond\nthird\nfourth\n";

function paste(editor: Editor, text: string): void {
	editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

function submit(editor: Editor): string {
	let result = "";
	editor.onSubmit = (text) => {
		result = text;
	};
	editor.handleInput("\r");
	return result;
}

describe("compact prompt content", () => {
	let dir: string;
	let terminal: VirtualTerminal;
	let tui: TuiMainScreen;
	let editor: CustomEditor;
	let keybindings: KeybindingsManager;
	let previousKeybindings: ReturnType<typeof getKeybindings>;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-prompt-content-"));
		previousKeybindings = getKeybindings();
		keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		terminal = new VirtualTerminal(80, 24);
		tui = new TuiMainScreen(terminal);
		editor = new CustomEditor(tui, getEditorTheme(), keybindings);
	});
	afterEach(() => {
		tui.stop();
		setKeybindings(previousKeybindings);
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		["one\ntwo\nthree", false],
		["one\ntwo\nthree\nfour", true],
		["x".repeat(300), false],
		["x".repeat(301), true],
	])("collapses only at the agreed paste boundary (%s)", (text, collapsed) => {
		paste(editor, text);
		expect(editor.getContentItems().map((item) => item.content)).toEqual(collapsed ? [{ kind: "paste", text }] : []);
		if (collapsed) expect(editor.getLines()).toEqual([editor.getContentItems()[0]!.marker]);
		else expect(editor.getText()).toBe(text);
		expect(submit(editor)).toBe(text);
	});

	it("keeps typed text, URLs, and @references visible", () => {
		const typed = "a".repeat(301);
		for (const char of typed) editor.handleInput(char);
		expect(editor.getText()).toBe(typed);
		expect(editor.getContentItems()).toEqual([]);
		for (const text of [`https://example.test/${"x".repeat(400)}`, `@/${"a".repeat(400)}`]) {
			editor.setText("");
			paste(editor, text);
			expect(editor.getText()).toBe(text);
			expect(editor.getContentItems()).toEqual([]);
		}
	});

	it("compacts the clipboard insertion path and restores the whole insertion with one undo", () => {
		editor.setText("inspect ");
		editor.insertTextAtCursor(block);
		expect(editor.getContentItems().map((item) => item.content)).toEqual([{ kind: "paste", text: block }]);
		expect(editor.getExpandedText()).toBe(`inspect ${block}`);
		editor.handleInput("\x1b[45;5u");
		expect(editor.getExpandedText()).toBe("inspect ");
		expect(editor.getContentItems()).toEqual([]);
	});

	it("preserves original path spelling and separators for mixed attachments", () => {
		const first = join(dir, "first file].txt");
		const second = join(dir, "image.png");
		writeFileSync(first, "file body");
		writeFileSync(
			second,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const input = ` '${first}'\n${second} `;
		editor.insertTextAtCursor(input);
		expect(editor.getContentItems().map((item) => item.content)).toMatchObject([
			{ kind: "file", path: first, text: `'${first}'` },
			{ kind: "image", path: second, text: second },
		]);
		expect(editor.getExpandedText()).toBe(input);
		expect(submit(editor)).toBe(input.trim());
	});

	it("decodes shell-escaped drag paths for preview without changing submitted text", () => {
		const path = join(dir, "a b's.txt");
		writeFileSync(path, "original file");
		const raw = path.replaceAll(" ", "\\ ").replaceAll("'", "\\'");
		paste(editor, raw);
		expect(editor.getContentItems()[0]!.content).toMatchObject({ kind: "file", path, text: raw });
		expect(submit(editor)).toBe(raw);
	});

	it("does not classify mixed prose or shell command arguments as attachments", () => {
		const path = join(dir, "a b.txt");
		writeFileSync(path, "body");
		paste(editor, `look at ${path}`);
		expect(editor.getText()).toBe(`look at ${path}`);
		expect(editor.getContentItems()).toEqual([]);
		editor.setText("!cat ");
		editor.insertTextAtCursor(`'${path}'`);
		expect(editor.getText()).toBe(`!cat '${path}'`);
		expect(submit(editor)).toBe(`!cat '${path}'`);
	});

	it("preserves all remaining payloads when deletion renumbers double-digit markers before the cursor", () => {
		for (let index = 0; index < 12; index++) {
			editor.handleInput("\x01");
			editor.insertContent([{ kind: "paste", text: `payload-${index}\n1\n2\n3` }]);
		}
		const items = editor.getContentItems();
		editor.handleInput("\x05");
		editor.handleInput("\x7f");
		expect(editor.getCursor().col).toBe(editor.getText().length);
		expect(submit(editor)).toBe(
			items
				.slice(0, -1)
				.map((item) => item.content.text)
				.join(""),
		);
	});

	it("keeps attachment deletion atomic through forward delete, undo, and character jumps", () => {
		const path = join(dir, "file.txt");
		writeFileSync(path, "body");
		paste(editor, path);
		editor.handleInput("\x01");
		editor.handleInput("\x1b[3~");
		expect(editor.getExpandedText()).toBe("");
		editor.handleInput("\x1b[45;5u");
		expect(editor.getExpandedText()).toBe(path);
		editor.handleInput("\x01");
		editor.handleInput("\x1d");
		editor.handleInput("f");
		editor.handleInput("\x7f");
		expect(editor.getExpandedText()).toBe("");
	});

	it("preserves attachments with empty or delimiter-bearing display labels", () => {
		const path = join(dir, "original.txt");
		writeFileSync(path, "body");
		editor.insertContent([
			{ kind: "file", path, text: path, label: "" },
			" ",
			{ kind: "file", path, text: path, label: "[]\n" },
		]);
		expect(submit(editor)).toBe(`${path} ${path}`);
	});

	it("does not recursively interpret literal markers inside another pasted block", () => {
		paste(editor, block);
		const literal = editor.getText();
		const second = `example\n${literal}\nthree\nfour`;
		paste(editor, second);
		expect(submit(editor)).toBe((block + second).trim());
	});

	it("keeps killed content recoverable after submission clears its original registry", () => {
		paste(editor, block);
		editor.handleInput("\x15");
		editor.handleInput("other prompt");
		expect(submit(editor)).toBe("other prompt");
		editor.handleInput("\x19");
		expect(submit(editor)).toBe(block.trim());
	});

	it("keeps marker examples literal when killed content is yanked and cycled", () => {
		const generic = new Editor(tui, getEditorTheme());
		generic.setText("older");
		generic.handleInput("\x15");
		const tail = "tail\none\ntwo\nthree\nfour";
		generic.insertContent([
			{ kind: "paste", text: block },
			{ kind: "paste", text: tail },
		]);
		const items = generic.getContentItems();
		const first = items[0]!.content;
		assert(first.kind === "paste");
		const updated = `example ${items[1]!.marker}\none\ntwo`;
		generic.updatePaste(first, updated);
		generic.handleInput("\x15");
		generic.handleInput("\x19");
		expect(generic.getExpandedText()).toBe(updated + tail);
		generic.handleInput("\x1by");
		expect(generic.getExpandedText()).toBe("older");
		generic.handleInput("\x1by");
		expect(submit(generic)).toBe(updated + tail);
	});

	it("applies and cancels preview edits without submitting or stripping block whitespace", () => {
		paste(editor, block);
		const item = editor.getContentItems()[0]!;
		assert(item.content.kind === "paste");
		let closed = false;
		const preview = new PromptContentPreview(tui, keybindings, editor, [item], item, () => {
			closed = true;
		});
		preview.handleInput("edited");
		preview.handleInput("\x1b");
		expect(closed).toBe(true);
		expect(editor.getExpandedText()).toBe(block);
		const second = new PromptContentPreview(tui, keybindings, editor, [item], item, () => {
			closed = true;
		});
		second.handleInput("edited");
		second.handleInput("\r");
		expect(editor.getExpandedText()).toBe(`${block}edited`);
		editor.handleInput("\x1b[45;5u");
		expect(editor.getExpandedText()).toBe(block);
		expect(editor.updatePaste(item.content, "stale")).toBe(false);
	});

	it("uses the configurable preview action and returns focus before main Enter submits", () => {
		keybindings = new KeybindingsManager({ "app.editor.preview": "ctrl+e" });
		setKeybindings(keybindings);
		editor = new CustomEditor(tui, getEditorTheme(), keybindings);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		paste(editor, block);
		terminal.sendInput("\x05");
		expect(tui.hasOverlay()).toBe(true);
		terminal.sendInput("edited");
		terminal.sendInput("\r");
		expect(tui.hasOverlay()).toBe(false);
		expect(submit(editor)).toBe(`${block}edited`.trim());
	});

	it("previews a real file read-only and keeps failed preview content in the prompt", async () => {
		const path = join(dir, "preview.txt");
		writeFileSync(path, "visible file body\nsecond line");
		paste(editor, path);
		const item = editor.getContentItems()[0]!;
		let closed = false;
		const preview = new PromptContentPreview(tui, keybindings, editor, [item], item, () => {
			preview.dispose();
			closed = true;
		});
		await vi.waitFor(() => expect(preview.render(72).join("\n")).toContain("visible file body"));
		preview.handleInput("overwrite");
		preview.handleInput("\x1b");
		expect(closed).toBe(true);
		expect(editor.getExpandedText()).toBe(path);
		expect(readFileSync(path, "utf8")).toBe("visible file body\nsecond line");
		rmSync(path);
		const failed = new PromptContentPreview(tui, keybindings, editor, [item], item, () => failed.dispose());
		await vi.waitFor(() => expect(failed.render(72).join("\n")).toContain("ENOENT"));
		failed.handleInput("\x1b");
		expect(submit(editor)).toBe(path);
	});
});
