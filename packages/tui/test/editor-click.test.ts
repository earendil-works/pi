import assert from "node:assert";
import { test } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function click(terminal: VirtualTerminal, x: number, y: number): void {
	terminal.sendInput(`\x1b[<0;${x};${y}M`);
	terminal.sendInput(`\x1b[<0;${x};${y}m`);
}

test("mouse clicks move the editor cursor across wrapped graphemes", async () => {
	const terminal = new VirtualTerminal(16, 6);
	const tui = new TuiAltScreen(terminal);
	const editor = new Editor(tui, defaultEditorTheme, { paddingX: 2 });
	editor.setText("hello 🙂 world");
	const root = new Container();
	root.addChild(editor);
	tui.setLayoutRoot(root);
	tui.setFocus(editor);
	tui.start();
	await terminal.waitForRender();

	click(terminal, 10, 2);
	assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });

	click(terminal, 5, 3);
	assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

	click(terminal, 15, 3);
	assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 14 });

	click(terminal, 1, 1);
	assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 14 });

	tui.stop();
});
