import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from "@earendil-works/pi-tui";
import type { Theme } from "./theme.ts";

/**
 * A runtime-owned, swappable theme (p2-tui-port.md section 5.3). Derived pi-tui themes are created once per ref and
 * dereference `ref.current` on every call, so a swap never leaves stale derived objects. Components that bake colors
 * into strings subscribe (or implement `themeChanged()`) and rebuild; caches key on `version`.
 */
export class ThemeRef {
	private theme: Theme;
	private listeners = new Set<(theme: Theme) => void>();
	version = 0;
	readonly markdown: MarkdownTheme;
	readonly selectList: SelectListTheme;
	readonly editor: EditorTheme;
	readonly settingsList: SettingsListTheme;
	constructor(theme: Theme) {
		this.theme = theme;
		const fg = (token: Parameters<Theme["fg"]>[0]) => (text: string) => this.theme.fg(token, text);
		this.markdown = {
			heading: fg("mdHeading"),
			link: fg("mdLink"),
			linkUrl: fg("mdLinkUrl"),
			code: fg("mdCode"),
			codeBlock: fg("mdCodeBlock"),
			codeBlockBorder: fg("mdCodeBlockBorder"),
			quote: fg("mdQuote"),
			quoteBorder: fg("mdQuoteBorder"),
			hr: fg("mdHr"),
			listBullet: fg("mdListBullet"),
			bold: (text) => this.theme.bold(text),
			italic: (text) => this.theme.italic(text),
			underline: (text) => this.theme.underline(text),
			strikethrough: (text) => this.theme.strikethrough(text),
			highlightCode: (code, lang) => this.theme.highlight(code, lang),
		};
		this.selectList = {
			selectedPrefix: fg("accent"),
			selectedText: fg("accent"),
			description: fg("muted"),
			scrollInfo: fg("muted"),
			noMatch: fg("muted"),
		};
		this.editor = { borderColor: fg("borderMuted"), selectList: this.selectList };
		const ref = this;
		this.settingsList = {
			label: (text, selected) => (selected ? this.theme.fg("accent", text) : text),
			value: (text, selected) => (selected ? this.theme.fg("accent", text) : this.theme.fg("muted", text)),
			description: fg("dim"),
			get cursor() {
				return ref.theme.fg("accent", "→ ");
			},
			hint: fg("dim"),
		};
	}
	get current(): Theme {
		return this.theme;
	}
	/** Runtime only: plugins change themes through preferences, never directly. */
	set(theme: Theme): void {
		if (theme === this.theme) return;
		this.theme = theme;
		this.version++;
		for (const listener of [...this.listeners]) listener(theme);
	}
	subscribe(listener: (theme: Theme) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
