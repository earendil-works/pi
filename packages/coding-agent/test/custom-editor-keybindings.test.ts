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

describe("CustomEditor follow-up autocomplete confirmation", () => {
	it("completes a suggested slash command before running follow-up on Alt+Enter", async () => {
		const keybindings = new KeybindingsManager({
			"app.message.followUp": "alt+enter",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		const followUps: string[] = [];
		editor.onAction("app.message.followUp", () => {
			followUps.push(editor.getText().trim());
			editor.setText("");
		});
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (!prefix.startsWith("/")) return null;
				return {
					items: [{ value: "proof", label: "proof" }],
					prefix,
				};
			},
			applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
				lines: lines.map((line, index) => (index === cursorLine ? `/${item.value} ` : line)),
				cursorLine,
				cursorCol: item.value.length + 2,
			}),
		});

		for (const ch of "/pro") {
			editor.handleInput(ch);
		}
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		editor.handleInput("\x1b\r"); // Alt+Enter

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(followUps).toEqual(["/proof"]);
	});

	it("applies non-command autocomplete without submitting follow-up on Alt+Enter", async () => {
		const keybindings = new KeybindingsManager({
			"app.message.followUp": "alt+enter",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		const followUps: string[] = [];
		editor.onAction("app.message.followUp", () => {
			followUps.push(editor.getText().trim());
			editor.setText("");
		});
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const match = beforeCursor.match(/@\S*$/);
				if (!match) return null;
				return {
					items: [{ value: "@src/foo.ts", label: "src/foo.ts" }],
					prefix: match[0],
				};
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const line = lines[cursorLine] ?? "";
				const next = `${line.slice(0, cursorCol - prefix.length)}${item.value} ${line.slice(cursorCol)}`;
				return {
					lines: lines.map((entry, index) => (index === cursorLine ? next : entry)),
					cursorLine,
					cursorCol: cursorCol - prefix.length + item.value.length + 1,
				};
			},
		});

		for (const ch of "check @src/fo") {
			editor.handleInput(ch);
		}
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		editor.handleInput("\x1b\r"); // Alt+Enter confirms the file completion first

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getText()).toBe("check @src/foo.ts ");
		expect(followUps).toEqual([]);

		editor.handleInput("\x1b\r"); // Second Alt+Enter submits the follow-up
		expect(followUps).toEqual(["check @src/foo.ts"]);
	});
});
