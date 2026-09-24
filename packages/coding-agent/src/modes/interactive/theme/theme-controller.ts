import type { RgbColor, TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	detectTerminalThemeForAuto,
	initTheme,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setTerminalDefaultColors,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

type ThemeResult = { success: boolean; error?: string };

const TERMINAL_QUERY_TIMEOUT_MS = 100;

function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);
}

export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly getSettingsManager: () => SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private currentThemeSetting: string | undefined;
	private terminalTheme: TerminalTheme = detectTerminalBackgroundFromEnv().theme;
	// Last reported default colors; a query that times out keeps them instead of erasing them.
	private terminalColors: { foreground?: RgbColor; background?: RgbColor } = {};
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;

	constructor(
		ui: TUI,
		options: {
			getSettingsManager: () => SettingsManager;
			showError: (message: string) => void;
			onChanged: () => void;
			initialThemeSetting?: string;
		},
	) {
		this.ui = ui;
		this.getSettingsManager = options.getSettingsManager;
		this.showError = options.showError;
		this.onChanged = options.onChanged;
		this.currentThemeSetting = options.initialThemeSetting;
		this.activeThemeName = resolveThemeSetting(
			this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting(),
			this.terminalTheme,
		);
		initTheme(this.activeThemeName, true);
		this.bindTerminalColorSchemeListener();
	}

	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}

	async applyFromSettings(): Promise<void> {
		const settingsManager = this.getSettingsManager();
		const themeSetting = this.currentThemeSetting ?? settingsManager.getThemeSetting();
		const autoTheme = parseAutoThemeSetting(themeSetting);
		// Theme detection reuses the background reply of the default color query.
		const background = this.queryTerminalDefaultColors();
		const detector = {
			queryTerminalBackgroundColor: () => background,
			queryTerminalColorScheme: (options: { timeoutMs: number }) => this.ui.queryTerminalColorScheme(options),
		};
		if (autoTheme) {
			this.terminalTheme = await detectTerminalThemeForAuto({ ui: detector, timeoutMs: TERMINAL_QUERY_TIMEOUT_MS });
			this.setAutoSync(true);
			this.applyThemeName(this.terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme, true);
			return;
		}

		this.setAutoSync(false);
		if (themeSetting !== undefined) {
			this.applyThemeName(themeSetting, true);
			return;
		}

		const detection = await detectTerminalBackgroundTheme({ ui: detector, timeoutMs: TERMINAL_QUERY_TIMEOUT_MS });
		this.terminalTheme = detection.theme;
		if (!this.applyThemeName(detection.theme).success) return;
		if (detection.confidence === "high") {
			settingsManager.setTheme(detection.theme);
			await settingsManager.flush();
		}
	}

	getThemeSelection(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting() ?? this.activeThemeName;
	}

	setThemeName(themeName: string, showError = false): ThemeResult {
		this.setAutoSync(false);
		const result = this.applyThemeName(themeName, showError);
		if (result.success) {
			this.currentThemeSetting = themeName;
		}
		return result;
	}

	async setThemeSetting(themeSetting: string): Promise<void> {
		this.currentThemeSetting = themeSetting;
		await this.applyFromSettings();
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

	dispose(): void {
		this.setAutoSync(false);
		this.terminalColorSchemeUnsubscribe?.();
		this.terminalColorSchemeUnsubscribe = undefined;
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

	/**
	 * Query the terminal's default colors, which themes use for tokens set to "". Startup does not
	 * wait for the replies; the UI re-renders when they arrive. Returns the background reply.
	 */
	private queryTerminalDefaultColors(): Promise<RgbColor | undefined> {
		const timeoutMs = TERMINAL_QUERY_TIMEOUT_MS;
		const foreground = this.ui.queryTerminalForegroundColor({ timeoutMs });
		const background = this.ui.queryTerminalBackgroundColor({ timeoutMs });
		void Promise.all([foreground, background]).then(([foregroundColor, backgroundColor]) => {
			const previous = this.terminalColors;
			const next = {
				foreground: foregroundColor ?? previous.foreground,
				background: backgroundColor ?? previous.background,
			};
			// Re-rendering rebuilds every component, so skip it when nothing changed (including timeouts).
			if (sameRgb(next.foreground, previous.foreground) && sameRgb(next.background, previous.background)) return;
			this.terminalColors = next;
			setTerminalDefaultColors(next);
			this.ui.invalidate();
			this.ui.requestRender();
		});
		return background;
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

	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			this.applyTerminalTheme(terminalTheme),
		);
	}

	private applyTerminalTheme(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		this.terminalTheme = terminalTheme;
		// Switching light/dark changes the terminal's default colors too.
		void this.queryTerminalDefaultColors();
		const autoTheme = parseAutoThemeSetting(this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting());
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
