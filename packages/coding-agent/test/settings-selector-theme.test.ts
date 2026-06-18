import { describe, expect, it, vi } from "vitest";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector.ts";
import { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createConfig(): SettingsConfig {
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
	it("opens a theme list and switches to automatic mode", () => {
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

		expect(callbacks.onThemeChange).toHaveBeenCalledWith("light/dark");
		const automaticOutput = component.getSettingsList().render(100).join("\n");
		expect(automaticOutput).toContain("Light theme");
		expect(automaticOutput).toContain("Dark theme");
		expect(automaticOutput).toContain("Change mode");
		expect(automaticOutput).toContain("switch to single theme");
	});
});
