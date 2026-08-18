import assert from "node:assert";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("editor prefix appears once and preserves wrapping width", () => {
	const tui = new TuiMainScreen(new VirtualTerminal(16, 24));
	const editor = new Editor(tui, defaultEditorTheme, { paddingX: 2, prefix: "❯ " });
	editor.setText("1234567890abcdef");

	const lines = editor.render(16).map(stripVTControlCharacters);
	const content = lines.slice(1, -1);
	assert.ok(content[0]?.startsWith("  ❯ 1234567890"));
	assert.ok(content[1]?.startsWith("    abcdef"));
	assert.strictEqual(content.filter((line) => line.includes("❯")).length, 1);
	assert.ok(lines.every((line) => visibleWidth(line) === 16));

	editor.setPrefix("λ ");
	assert.ok(editor.render(16).map(stripVTControlCharacters)[1]?.startsWith("  λ "));
});
