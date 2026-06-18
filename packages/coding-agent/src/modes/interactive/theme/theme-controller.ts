import type { TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	initTheme,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

type ThemeResult = { success: boolean; error?: string };

export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly settingsManager: SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private terminalTheme: TerminalTheme = detectTerminalBackgroundFromEnv().theme;
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;

	constructor(ui: TUI, settingsManager: SettingsManager, showError: (message: string) => void, onChanged: () => void) {
		this.ui = ui;
		this.settingsManager = settingsManager;
		this.showError = showError;
		this.onChanged = onChanged;
		this.activeThemeName = resolveThemeSetting(this.settingsManager.getThemeSetting(), this.terminalTheme);
		initTheme(this.activeThemeName, true);
		this.ui.onTerminalColorSchemeChange((terminalTheme) => this.applyTerminalTheme(terminalTheme));
	}

	async applyFromSettings(): Promise<void> {
		const themeSetting = this.settingsManager.getThemeSetting();
		const autoTheme = parseAutoThemeSetting(themeSetting);
		if (autoTheme) {
			this.terminalTheme = await this.detectTerminalThemeForAuto();
			this.setAutoSync(true);
			this.applyThemeName(this.terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme, true);
			return;
		}

		this.setAutoSync(false);
		if (themeSetting !== undefined) {
			this.applyThemeName(themeSetting, true);
			return;
		}

		const detection = await detectTerminalBackgroundTheme({ ui: this.ui, timeoutMs: 100 });
		this.terminalTheme = detection.theme;
		if (!this.applyThemeName(detection.theme).success) return;
		if (detection.confidence === "high") {
			this.settingsManager.setTheme(detection.theme);
			await this.settingsManager.flush();
		}
	}

	setThemeName(themeName: string, showError = false): ThemeResult {
		this.setAutoSync(false);
		return this.applyThemeName(themeName, showError);
	}

	setThemeInstance(themeInstance: Theme): ThemeResult {
		this.setAutoSync(false);
		setThemeInstance(themeInstance);
		this.activeThemeName = "<in-memory>";
		this.notifyChanged();
		return { success: true };
	}

	preview(themeSettingOrName: string): void {
		const themeName = resolveThemeSetting(themeSettingOrName, this.terminalTheme) ?? this.activeThemeName;
		if (!themeName) return;
		if (setTheme(themeName, true).success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	disableAutoSync(): void {
		this.setAutoSync(false);
	}

	getTerminalTheme(): TerminalTheme {
		return this.terminalTheme;
	}

	private applyThemeName(themeName: string, showError = false): ThemeResult {
		const result = setTheme(themeName, true);
		this.activeThemeName = result.success ? themeName : "dark";
		this.notifyChanged();
		if (!result.success && showError) {
			this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
		}
		return result;
	}

	private notifyChanged(): void {
		this.ui.invalidate();
		this.onChanged();
	}

	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	private async detectTerminalThemeForAuto(): Promise<TerminalTheme> {
		try {
			const colorScheme = await this.ui.queryTerminalColorScheme({ timeoutMs: 100 });
			if (colorScheme) return colorScheme;
		} catch {
			// Fall back to OSC 11 / COLORFGBG detection when color-scheme DSR is unsupported.
		}
		return (await detectTerminalBackgroundTheme({ ui: this.ui, timeoutMs: 100 })).theme;
	}

	private applyTerminalTheme(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		this.terminalTheme = terminalTheme;
		const autoTheme = parseAutoThemeSetting(this.settingsManager.getThemeSetting());
		if (!autoTheme) {
			this.setAutoSync(false);
			return;
		}
		const themeName = terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
		if (themeName !== this.activeThemeName) {
			this.applyThemeName(themeName);
		}
	}
}
