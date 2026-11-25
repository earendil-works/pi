import { setKeybindings, stripTerminalSequences, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("ExtensionEditorComponent hint", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("names the key that submits the editor", () => {
		const keybindings = new KeybindingsManager({ "tui.input.submit": "ctrl+s" });
		setKeybindings(keybindings);
		const onSubmit = vi.fn();
		const component = new ExtensionEditorComponent(
			new TuiMainScreen(new VirtualTerminal()),
			keybindings,
			"Title",
			"text",
			onSubmit,
			() => {},
		);

		const output = stripTerminalSequences(component.render(120).join("\n"));
		expect(output).toContain("ctrl+s submit");

		component.handleInput("\x1b[115;5u"); // ctrl+s (Kitty keyboard protocol)
		expect(onSubmit).toHaveBeenCalledWith("text");
	});
});
