import { describe, expect, it, vi } from "vitest";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector.ts";
import { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		showImages: false,
		imageWidthCells: 80,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "all",
		followUpMode: "all",
		transport: "auto",
		httpIdleTimeoutMs: 300000,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "medium", "high"],
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark", "light"],
		hideThinkingBlock: false,
		collapseChangelog: false,
		enableInstallTelemetry: false,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 1,
		autocompleteMaxVisible: 7,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		warnings: {},
		...overrides,
	};
}

function createCallbacks(): SettingsCallbacks {
	const noop = () => {};
	return {
		onAutoCompactChange: noop,
		onShowImagesChange: noop,
		onImageWidthCellsChange: noop,
		onAutoResizeImagesChange: noop,
		onBlockImagesChange: noop,
		onEnableSkillCommandsChange: noop,
		onSteeringModeChange: noop,
		onFollowUpModeChange: noop,
		onTransportChange: noop,
		onHttpIdleTimeoutMsChange: noop,
		onThinkingLevelChange: noop,
		onThemeChange: vi.fn(),
		onThemePreview: noop,
		onHideThinkingBlockChange: noop,
		onCollapseChangelogChange: noop,
		onEnableInstallTelemetryChange: noop,
		onDoubleEscapeActionChange: noop,
		onTreeFilterModeChange: noop,
		onShowHardwareCursorChange: noop,
		onEditorPaddingXChange: noop,
		onAutocompleteMaxVisibleChange: noop,
		onQuietStartupChange: noop,
		onDefaultProjectTrustChange: noop,
		onClearOnShrinkChange: noop,
		onShowTerminalProgressChange: noop,
		onWarningsChange: noop,
		onCancel: noop,
	};
}

function openThemeSetting(component: SettingsSelectorComponent): void {
	const settingsList = component.getSettingsList();
	for (const char of "theme") settingsList.handleInput(char);
	settingsList.handleInput("\r");
}

describe("SettingsSelectorComponent theme settings", () => {
	it("opens a theme list, switches to automatic mode, and saves it", () => {
		initTheme("dark");
		const callbacks = createCallbacks();
		const component = new SettingsSelectorComponent(createConfig(), callbacks);

		openThemeSetting(component);

		const output = component.getSettingsList().render(100).join("\n");
		expect(output).toContain("Automatic");
		expect(output).toContain("dark");
		expect(output).toContain("light");

		component.getSettingsList().handleInput("\x1b[A");
		component.getSettingsList().handleInput("\r");

		expect(callbacks.onThemeChange).toHaveBeenCalledWith("dark/dark");
		const automaticOutput = component.getSettingsList().render(100).join("\n");
		expect(automaticOutput).toContain("Light theme");
		expect(automaticOutput).toContain("Dark theme");
		expect(automaticOutput).toContain("Change mode");
		expect(automaticOutput).toContain("switch to single theme");
		expect(automaticOutput).not.toContain("Save");
		expect(automaticOutput).toContain("Esc to save");

		component.getSettingsList().handleInput("\x1b");

		expect(callbacks.onThemeChange).toHaveBeenLastCalledWith("dark/dark");
		const savedOutput = component.getSettingsList().render(100).join("\n");
		expect(savedOutput).toContain("Theme");
		expect(savedOutput).toContain("dark/dark");
	});

	it("switches automatic mode back to the active terminal-side theme", () => {
		initTheme("dark");
		const callbacks = createCallbacks();
		const component = new SettingsSelectorComponent(
			createConfig({
				currentTheme: "solarized-light/tokyo-night",
				terminalTheme: "light",
				availableThemes: ["dark", "light", "solarized-light", "tokyo-night"],
			}),
			callbacks,
		);

		openThemeSetting(component);
		component.getSettingsList().handleInput("\x1b[B");
		component.getSettingsList().handleInput("\x1b[B");
		component.getSettingsList().handleInput("\r");

		expect(callbacks.onThemeChange).toHaveBeenCalledWith("solarized-light");
	});
});
