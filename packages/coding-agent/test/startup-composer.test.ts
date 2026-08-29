import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createStartupComposer, StartupComposer, showStartupSelector } from "../src/cli/startup-ui.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

class RecordingTerminal extends VirtualTerminal implements Terminal {
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

function createComposerTui(terminal: VirtualTerminal): TUI {
	return new TuiMainScreen(terminal);
}

describe("StartupComposer", () => {
	// Regression coverage for #8689.
	it("keeps draft text when Enter is pressed and reports cancellation", () => {
		setKeybindings(new KeybindingsManager());
		const terminal = new VirtualTerminal();
		const ui = createComposerTui(terminal);
		const onCancel = vi.fn();
		const composer = new StartupComposer(ui, { onCancel });
		ui.addChild(composer);
		ui.setFocus(composer);
		ui.start();

		try {
			terminal.sendInput("draft /model");
			terminal.sendInput("\r");
			expect(composer.getText()).toBe("draft /model");

			terminal.sendInput("\x1b");
			expect(onCancel).toHaveBeenCalledWith("interrupt");
		} finally {
			ui.stop();
		}
	});

	// Regression coverage for #8689.
	it("pauses the composer while a selector uses the same terminal", async () => {
		setKeybindings(new KeybindingsManager());
		const terminal = new RecordingTerminal();
		const settingsManager = SettingsManager.inMemory();
		const startup = createStartupComposer(settingsManager, { terminal });
		terminal.sendInput("draft");

		const selectedPromise = showStartupSelector(
			settingsManager,
			"Trust project folder?",
			[{ label: "Trust", value: true }],
			{ handoff: startup },
		);
		expect(startup.isRunning()).toBe(false);
		expect(startup.ui.terminal).toBe(terminal);

		// Selector input must not be appended to the hidden composer.
		terminal.sendInput("wrong");
		terminal.sendInput("\r");

		expect(await selectedPromise).toBe(true);
		expect(startup.isRunning()).toBe(true);
		expect(startup.composer.getText()).toBe("draft");
		expect(terminal.startCount).toBe(3);
		expect(terminal.stopCount).toBe(2);

		startup.stop();
		expect(terminal.stopCount).toBe(3);
	});
});
