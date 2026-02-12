import { describe, expect, it, vi } from "vitest";
import { getEditorTheme, initTheme } from "../theme/theme.js";
import { CustomEditor } from "./custom-editor.js";

describe("CustomEditor Ctrl+O handling", () => {
	initTheme("dark");

	it("handles ASCII Ctrl+O", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onCtrlO = vi.fn();
		editor.onCtrlO = onCtrlO;

		editor.handleInput("\x0f");

		expect(onCtrlO).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("handles Kitty Ctrl+O sequence", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onCtrlO = vi.fn();
		editor.onCtrlO = onCtrlO;

		editor.handleInput("\x1b[111;5u");

		expect(onCtrlO).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("handles batched Ctrl+O + text chunk", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onCtrlO = vi.fn();
		editor.onCtrlO = onCtrlO;

		editor.handleInput("\x0fabc");

		expect(onCtrlO).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("abc");
	});
});
