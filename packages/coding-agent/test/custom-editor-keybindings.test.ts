import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor prompt history keybindings", () => {
	it("gives an explicit history binding precedence over model cycling", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			modelCycles++;
		});
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("previous prompt");
		expect(modelCycles).toBe(0);

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("draft");
	});
});

describe("CustomEditor selection page keybindings", () => {
	it("pages an open autocomplete menu before pasting an image with the same key (#7629)", async () => {
		// Bind both explicitly: the paste default is Alt+V on Windows and WSL.
		const keybindings = new KeybindingsManager({
			"tui.select.pageDown": "ctrl+v",
			"app.clipboard.pasteImage": "ctrl+v",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let pastes = 0;
		editor.onPasteImage = () => {
			pastes++;
		};
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				items: Array.from({ length: 12 }, (_, index) => ({
					value: `/command-${index}`,
					label: `command-${index}`,
				})),
				prefix: "/",
			}),
			applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
				lines: lines.map((line, index) => (index === cursorLine ? item.value : line)),
				cursorLine,
				cursorCol: item.value.length,
			}),
		});

		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x16"); // Ctrl+V
		editor.handleInput("\r");

		expect(pastes).toBe(0);
		expect(submitted).toBe("/command-5");

		editor.handleInput("\x16"); // Ctrl+V with autocomplete closed pastes again
		expect(pastes).toBe(1);
	});
});
