import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	CustomEditor,
	type EditorBorderContent,
	type EditorBorderSlot,
} from "../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createEditor(embedWorkingStatus = false): CustomEditor {
	const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
	return new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), { embedWorkingStatus });
}

/** Content with fixed full and compact forms. */
function fixedContent(full: string, compact?: string): EditorBorderContent {
	return { render: () => full, renderCompact: compact === undefined ? undefined : () => compact };
}

function topBorder(editor: CustomEditor, width: number): string {
	return stripAnsi(editor.render(width)[0]!);
}

function bottomBorder(editor: CustomEditor, width: number): string {
	const lines = editor.render(width);
	return stripAnsi(lines[lines.length - 1]!);
}

describe("CustomEditor border content", () => {
	it("renders top-right content at the end of the top border", () => {
		initTheme("dark");
		const editor = createEditor();
		editor.setBorderContent("topRight", "tr", fixedContent("TR"));

		expect(topBorder(editor, 30)).toBe(`${"─".repeat(24)} TR ──`);
	});

	it("renders top-left and top-right content in the corners", () => {
		initTheme("dark");
		const editor = createEditor();
		editor.setBorderContent("topLeft", "tl", fixedContent("TL"));
		editor.setBorderContent("topRight", "tr", fixedContent("TR"));

		expect(topBorder(editor, 30)).toBe(`── TL ${"─".repeat(18)} TR ──`);
	});

	it("renders bottom border content", () => {
		initTheme("dark");
		const editor = createEditor();
		editor.setBorderContent("bottomLeft", "bl", fixedContent("BL"));
		editor.setBorderContent("bottomRight", "br", fixedContent("BR"));

		expect(bottomBorder(editor, 30)).toBe(`── BL ${"─".repeat(18)} BR ──`);
	});

	it("keeps the embedded working indicator ahead of top-left content", () => {
		initTheme("dark");
		const editor = createEditor(true);
		const indicator = new WorkingStatusIndicator(
			{ requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI,
			"Working",
		);
		editor.setWorkingStatusIndicator(indicator);
		editor.setBorderContent("topLeft", "tl", fixedContent("W"));

		expect(topBorder(editor, 30)).toBe(`── ⠋ Working W ${"─".repeat(15)}`);
		indicator.dispose();
	});

	it("keeps the scroll label centered beside border content", async () => {
		initTheme("dark");
		const editor = createEditor();
		editor.setBorderContent("topRight", "tr", fixedContent("TR"));
		// Eight lines in a five-row viewport scroll the editor, so the top
		// border shows "↑ 3 more".
		editor.setText(["a", "b", "c", "d", "e", "f", "g", "h"].join("\n"));

		expect(topBorder(editor, 80)).toBe(`${"─".repeat(35)} ↑ 3 more ${"─".repeat(29)} TR ──`);
	});

	it("falls back to the compact form and then truncation when content does not fit", () => {
		initTheme("dark");
		const editor = createEditor();
		editor.setBorderContent("topLeft", "compact", fixedContent("X".repeat(20), "*"));
		expect(topBorder(editor, 20)).toBe(`── * ${"─".repeat(15)}`);

		const plain = createEditor();
		plain.setBorderContent("topLeft", "long", fixedContent("X".repeat(20)));
		expect(topBorder(plain, 20)).toBe(`── ${"X".repeat(15)} ─`);
	});

	it("keeps every border within the requested width", () => {
		initTheme("dark");
		const editor = createEditor(true);
		const indicator = new WorkingStatusIndicator(
			{ requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI,
			"Working",
		);
		editor.setWorkingStatusIndicator(indicator);
		const slots: EditorBorderSlot[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];
		for (const slot of slots) {
			editor.setBorderContent(slot, slot, fixedContent(`${slot} content`, "•"));
		}
		editor.setText(["a", "b", "c", "d", "e", "f", "g", "h"].join("\n"));

		for (const width of [1, 4, 10, 20, 80, 120]) {
			const lines = editor.render(width);
			for (const line of [lines[0]!, lines[lines.length - 1]!]) {
				expect(visibleWidth(line)).toBe(width);
			}
		}
		indicator.dispose();
	});

	it("clears slot content by key", () => {
		initTheme("dark");
		const editor = createEditor();
		editor.setBorderContent("topRight", "tr", fixedContent("TR"));
		editor.setBorderContent("topRight", "tr", undefined);

		expect(topBorder(editor, 30)).toBe("─".repeat(30));
	});
});
