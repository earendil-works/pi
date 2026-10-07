import { type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
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

function click(x: number, y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 30,
		height: 3,
		shift: false,
		alt: false,
		ctrl: false,
	};
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

describe("CustomEditor border content mouse input", () => {
	it("dispatches border clicks to the content under the pointer, with local coordinates", () => {
		initTheme("dark");
		const editor = createEditor();
		const seen: Array<{ label: string; x: number; width: number }> = [];
		const clickable = (label: string): EditorBorderContent => ({
			render: () => label,
			handleMouse: (event) => {
				seen.push({ label, x: event.x, width: event.width });
				return { handled: true };
			},
		});
		editor.setBorderContent("topLeft", "tl", clickable("TL"));
		editor.setBorderContent("topRight", "tr", clickable("TR"));
		editor.render(30); // "── TL ───────────────── TR ──"

		expect(editor.handleMouse(click(25, 0))).toEqual({ handled: true });
		expect(editor.handleMouse(click(4, 0))).toEqual({ handled: true });
		expect(seen).toEqual([
			{ label: "TR", x: 0, width: 2 },
			{ label: "TL", x: 1, width: 2 },
		]);
	});

	it("dispatches bottom border clicks and leaves border fill clicks to the base behavior", () => {
		initTheme("dark");
		const editor = createEditor();
		const seen: number[] = [];
		editor.setBorderContent("bottomLeft", "bl", {
			render: () => "BL",
			handleMouse: (event) => {
				seen.push(event.x);
				return { handled: true };
			},
		});
		editor.render(30); // rows: top border, one content row, bottom border

		expect(editor.handleMouse(click(3, 2))).toEqual({ handled: true });
		expect(seen).toEqual([0]);
		// Fill clicks reach no content: the base swallows border clicks.
		expect(editor.handleMouse(click(10, 2))).toEqual({ handled: true, focus: true });
		expect(editor.handleMouse(click(1, 0))).toEqual({ handled: true, focus: true });
		expect(seen).toEqual([0]);
	});
});
