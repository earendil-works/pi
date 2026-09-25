import type { RgbColor, TerminalColors, TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalTheme,
	initTheme,
	markTerminalColorsPending,
	parseAutoThemeSetting,
	resolveThemeSetting,
	SYSTEM_THEME_NAME,
	setTerminalColors,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

type ThemeResult = { success: boolean; error?: string };

/**
 * How long the system theme stays grayscale before falling back to palette indices. Terminals answer
 * the trailing DA1 request right after the color replies, so this only matters for terminals that
 * answer neither. Replies arriving later still apply.
 */
const TERMINAL_QUERY_TIMEOUT_MS = 100;

function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);
}

function sameTerminalColors(a: TerminalColors, b: TerminalColors): boolean {
	if (!sameRgb(a.foreground, b.foreground) || !sameRgb(a.background, b.background)) return false;
	if (a.palette === b.palette) return true;
	if (!a.palette || !b.palette || a.palette.length !== b.palette.length) return false;
	return a.palette.every((color, index) => sameRgb(color, b.palette?.[index]));
}

/**
 * Applies the theme setting and keeps it in sync with the terminal. The theme applies immediately, and the
 * terminal's colors update it when they arrive; the system theme renders in grayscale until then. Callers
 * that bake theme colors into content can wait for the colors with `waitForTerminalColors()`.
 */
export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly getSettingsManager: () => SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private currentThemeSetting: string | undefined;
	private terminalTheme: TerminalTheme = detectTerminalBackgroundFromEnv().theme;
	// Last reported colors; a query that times out keeps them instead of erasing them.
	private terminalColors: TerminalColors | undefined;
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;
	// Settles when the latest color query completed or timed out, and its colors applied.
	private terminalColorQuery: Promise<void> = Promise.resolve();

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
		this.activeThemeName = this.resolveThemeName();
		// The system theme starts in grayscale; color follows once the terminal reports its colors.
		markTerminalColorsPending();
		initTheme(this.activeThemeName, true);
		this.bindTerminalColorSchemeListener();
	}

	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}

	/** Apply the theme setting now and query the terminal's colors, which update the theme when they arrive. */
	applyFromSettings(): void {
		this.applySetting(true);
		this.queryTerminalColors();
	}

	/**
	 * Wait until the latest color query completed or timed out. Content that bakes theme colors into
	 * strings, such as the startup header, should be built after this. Terminals answer the DA1 request
	 * right after the color replies, so this only takes the full timeout when a terminal answers nothing.
	 */
	waitForTerminalColors(): Promise<void> {
		return this.terminalColorQuery;
	}

	getThemeSelection(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting() ?? this.activeThemeName;
	}

	setThemeName(themeName: string, showError = false): ThemeResult {
		this.setAutoSync(themeName === SYSTEM_THEME_NAME);
		const result = this.applyThemeName(themeName, showError);
		if (result.success) {
			this.currentThemeSetting = themeName;
		}
		return result;
	}

	setThemeSetting(themeSetting: string): void {
		this.currentThemeSetting = themeSetting;
		this.applyFromSettings();
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

	private getThemeSetting(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting();
	}

	/** The theme for the current setting and terminal appearance. Without a setting, pi uses the system theme. */
	private resolveThemeName(): string {
		return resolveThemeSetting(this.getThemeSetting(), this.terminalTheme) ?? SYSTEM_THEME_NAME;
	}

	/** Apply the current setting. Theme pairs and the system theme follow terminal appearance changes. */
	private applySetting(showError: boolean): void {
		const themeSetting = this.getThemeSetting();
		const themeName = this.resolveThemeName();
		this.setAutoSync(parseAutoThemeSetting(themeSetting) !== undefined || themeName === SYSTEM_THEME_NAME);
		this.applyThemeName(themeName, showError && themeSetting !== undefined);
	}

	private applyThemeName(themeName: string, showError = false): ThemeResult {
		const result = setTheme(themeName, true);
		this.activeThemeName = result.success ? themeName : SYSTEM_THEME_NAME;
		this.notifyChanged();
		if (!result.success && showError) {
			this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to the system theme.`);
		}
		return result;
	}

	/**
	 * Query the terminal's colors without waiting for them. They apply when the query completes or times
	 * out, and again if the terminal answers after the timeout.
	 */
	private queryTerminalColors(): void {
		const apply = (colors: TerminalColors) => this.applyTerminalColors(colors);
		let query: Promise<TerminalColors>;
		try {
			query = this.ui.queryTerminalColors({ timeoutMs: TERMINAL_QUERY_TIMEOUT_MS, onLateReply: apply });
		} catch {
			// Treat a failed query like a terminal that does not report colors.
			query = Promise.resolve({});
		}
		this.terminalColorQuery = query.then(apply, () => apply({}));
	}

	/**
	 * Record reported colors: themes use the default colors for tokens set to "", the system theme is
	 * generated from all of them, and light/dark detection uses them. Re-renders only when they changed.
	 */
	private applyTerminalColors(reported: TerminalColors): void {
		const previous = this.terminalColors;
		const next: TerminalColors = {
			foreground: reported.foreground ?? previous?.foreground,
			background: reported.background ?? previous?.background,
			palette: reported.palette ?? previous?.palette,
		};
		// Re-rendering rebuilds every component, so skip it when nothing changed (including timeouts).
		if (previous && sameTerminalColors(previous, next)) return;
		this.terminalColors = next;
		setTerminalColors(next);
		if (next.background) this.terminalTheme = detectTerminalTheme(next).theme;
		this.reapplyForTerminal();
		this.ui.invalidate();
		this.ui.requestRender();
	}

	/**
	 * Re-apply the setting after the terminal's colors or appearance changed: regenerate the system theme,
	 * or switch the theme of a pair. Themes set through extensions or previews are left alone.
	 */
	private reapplyForTerminal(): void {
		if (this.activeThemeName === "<in-memory>") return;
		const themeName = this.resolveThemeName();
		if (themeName === SYSTEM_THEME_NAME || themeName !== this.activeThemeName) {
			this.applyThemeName(themeName);
		}
	}

	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			this.applyTerminalColorSchemeChange(terminalTheme),
		);
	}

	/**
	 * The terminal reported a light/dark switch. Its colors changed too, so query them again: they decide
	 * the appearance. The reported scheme only applies to terminals that do not report their background.
	 */
	private applyTerminalColorSchemeChange(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		if (!this.terminalColors?.background && terminalTheme !== this.terminalTheme) {
			this.terminalTheme = terminalTheme;
			this.reapplyForTerminal();
		}
		this.queryTerminalColors();
	}

	private notifyChanged(): void {
		this.ui.invalidate();
		this.onChanged();
	}
}
