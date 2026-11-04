// Per-runtime preference state (p2-tui-port.md sections 4.2, 5.3): server defaults, the launcher's guest-local
// preferences, terminal colors and capabilities in; effective keybindings, settings and a ThemeRef out.
import type { KeybindingsConfig, TerminalColorMode } from "@earendil-works/pi-tui";
import { DEFAULT_KEY_PLATFORM, type KeyPlatform } from "../tui/keybindings.ts";
import { EMPTY_PREFERENCES, effectivePreferences, type TuiLocalPreferences } from "../tui/preferences.ts";
import { ThemeRef } from "../tui/theme/ref.ts";
import { resolveTheme, type TerminalState, type Theme } from "../tui/theme/theme.ts";
import type { TuiServerPreferences, TuiSettings } from "./tui-preferences.ts";

export type TuiCapabilities = { trueColor: boolean } & KeyPlatform;

export class TuiAppearance {
	readonly theme: ThemeRef;
	settings: TuiSettings = {};
	keybindings: KeybindingsConfig = {};
	themeSetting: string | undefined;
	themeError: string | undefined;
	local: TuiLocalPreferences = EMPTY_PREFERENCES;
	server: TuiServerPreferences | undefined;
	terminal: TerminalState = { colors: {} };
	capabilities: TuiCapabilities = { trueColor: false, ...DEFAULT_KEY_PLATFORM };
	private themeKey = "";
	private onChange: (appearance: TuiAppearance) => void;
	constructor(onChange: (appearance: TuiAppearance) => void, initial?: Theme) {
		this.onChange = onChange;
		this.theme = new ThemeRef(initial ?? this.resolve().theme);
		if (!initial) this.themeKey = this.key();
	}
	get colorMode(): TerminalColorMode {
		return (this.settings.terminal?.trueColor ?? this.capabilities.trueColor) ? "truecolor" : "256color";
	}
	get keyPlatform(): KeyPlatform {
		return { platform: this.capabilities.platform, windowsKeys: this.capabilities.windowsKeys };
	}
	update(
		patch: Partial<{
			local: TuiLocalPreferences;
			server: TuiServerPreferences;
			terminal: TerminalState;
			capabilities: TuiCapabilities;
		}>,
	): void {
		Object.assign(this, patch);
		const effective = effectivePreferences(this.server, this.local);
		this.settings = effective.settings;
		this.keybindings = effective.keybindings;
		this.themeSetting = effective.theme;
		const key = this.key();
		if (key !== this.themeKey) {
			this.themeKey = key;
			const { theme, error } = this.resolve();
			this.themeError = error;
			this.theme.set(theme);
		}
		this.onChange(this);
	}
	private resolve(): { theme: Theme; error?: string } {
		return resolveTheme({
			setting: this.themeSetting,
			themes: this.local.themes,
			mode: this.colorMode,
			terminal: this.terminal,
		});
	}
	private key(): string {
		const name = this.themeSetting ?? "";
		return JSON.stringify([name, this.local.themes, this.terminal, this.colorMode]);
	}
}
