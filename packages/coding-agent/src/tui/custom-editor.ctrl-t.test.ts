import { describe, expect, it, vi } from "vitest";
import { getEditorTheme, initTheme } from "../theme/theme.js";
import { CustomEditor } from "./custom-editor.js";

describe("CustomEditor Ctrl+T handling", () => {
	initTheme("dark");

	it("handles ASCII Ctrl+T", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onCtrlT = vi.fn();
		editor.onCtrlT = onCtrlT;

		editor.handleInput("\x14");

		expect(onCtrlT).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("handles batched Ctrl+T + text chunk", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onCtrlT = vi.fn();
		editor.onCtrlT = onCtrlT;

		editor.handleInput("\x14abc");

		expect(onCtrlT).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("abc");
	});
});
