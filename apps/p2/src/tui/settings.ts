// P10: `/settings` (after coding-agent's settings-selector.ts, the guest-local G settings of section 1.14), its theme
// picker (theme-selector.ts, with an isolated preview pane) and `/keybindings` (rebinding). Nothing is written here:
// changes are collected and proposed to the launcher as one `savePrefs` patch, which shows the diff and writes the
// visitor's own prefs.json after a local confirmation; the launcher's file watcher then applies them.
import {
	type Component,
	Container,
	type Focusable,
	isKeyRelease,
	type KeyId,
	Markdown,
	parseKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TuiContext } from "../runtime/tui-context.ts";
import type { TuiSettingField, TuiSettings } from "../runtime/tui-preferences.ts";
import { ListOverlay, type ListRow } from "./components/list-overlay.ts";
import { builtinKeybindings, isKeyId, isPrivileged } from "./keybindings.ts";
import { formatKeyText, lineText } from "./render-context.ts";
import type { ThemeRef } from "./theme/ref.ts";
import { parseAutoThemeSetting, SYSTEM_THEME_NAME } from "./theme/theme.ts";

type Value = boolean | number | string;
/** A G setting as pi's selector shows it: its path in prefs.json, pi's default and the values it cycles. */
type Field = { id: string; label: string; description: string; path: string[]; fallback: Value; values: Value[] };
const FIELDS: Field[] = [
	{
		id: "hide-thinking",
		label: "Hide thinking",
		description: "Hide thinking blocks in assistant responses",
		path: ["hideThinkingBlock"],
		// p2 hides thinking until the setting says otherwise (pi shows it by default).
		fallback: true,
		values: [true, false],
	},
	{
		id: "mermaid-rendering",
		label: "Mermaid diagrams",
		description: "Render Mermaid code blocks as diagrams",
		path: ["markdown", "mermaid"],
		fallback: "streaming",
		values: ["off", "final", "streaming"],
	},
	{
		id: "quiet-startup",
		label: "Quiet startup",
		description: "Hide the startup header (or keep only its first line)",
		path: ["quietStartup"],
		fallback: false,
		values: [true, "header", false],
	},
	{
		id: "show-hardware-cursor",
		label: "Show hardware cursor",
		description: "Show the terminal cursor while still positioning it for IME support",
		path: ["showHardwareCursor"],
		fallback: false,
		values: [true, false],
	},
	{
		id: "editor-padding",
		label: "Editor padding",
		description: "Horizontal padding for the input editor (0-3)",
		path: ["editorPaddingX"],
		fallback: 0,
		values: [0, 1, 2, 3],
	},
	{
		id: "output-padding",
		label: "Output padding",
		description: "Horizontal padding for transcript output",
		path: ["outputPad"],
		fallback: 1,
		values: [0, 1],
	},
	{
		id: "autocomplete-max-visible",
		label: "Autocomplete max items",
		description: "Maximum visible items in autocomplete",
		path: ["autocompleteMaxVisible"],
		fallback: 5,
		values: [3, 5, 7, 10, 15, 20],
	},
	{
		id: "clear-on-shrink",
		label: "Clear on shrink",
		description: "Clear empty rows when content shrinks",
		path: ["terminal", "clearOnShrink"],
		fallback: false,
		values: [true, false],
	},
	{
		id: "terminal-progress",
		label: "Terminal progress",
		description: "Show progress in the terminal tab while the agent works",
		path: ["terminal", "showTerminalProgress"],
		fallback: false,
		values: [true, false],
	},
	{
		id: "fullscreen-exit-output",
		label: "Fullscreen exit output",
		description: "What to print when leaving fullscreen",
		path: ["fullscreenExitOutput"],
		fallback: "transcript",
		values: ["transcript", "resume-hint"],
	},
	{
		id: "fullscreen-scrollbar",
		label: "Fullscreen scrollbar",
		description: "When to show the transcript scrollbar",
		path: ["fullscreenScrollbar"],
		fallback: "auto",
		values: ["auto", "always", "hidden"],
	},
	{
		id: "fullscreen-copy-on-select",
		label: "Fullscreen copy on select",
		description: "Copy a mouse selection when the button is released",
		path: ["fullscreenCopyOnSelect"],
		fallback: true,
		values: [true, false],
	},
	{
		id: "fullscreen-wheel-scroll-lines",
		label: "Fullscreen wheel scrolling",
		description: "Lines per mouse-wheel event; 'auto' speeds up fast spins",
		path: ["fullscreenWheelScrollLines"],
		fallback: "auto",
		values: ["auto", 1, 2, 3, 5, 10],
	},
	{
		id: "show-images",
		label: "Show images",
		description: "Render images inline (when the launcher supports them)",
		path: ["terminal", "showImages"],
		fallback: true,
		values: [true, false],
	},
	{
		id: "image-width-cells",
		label: "Image width",
		description: "Preferred inline image width in terminal cells",
		path: ["terminal", "imageWidthCells"],
		fallback: 60,
		values: [60, 80, 120],
	},
];

function read(settings: TuiSettings, path: string[]): unknown {
	let value: unknown = settings;
	for (const key of path)
		value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
	return value;
}

const box = (ctx: TuiContext, title: string, body: Component, footer: () => string) => {
	const container = new Container();
	const border = {
		render: (width: number) => [ctx.theme.current.fg("border", "─".repeat(Math.max(1, width)))],
		invalidate() {},
	};
	container.addChild(border);
	container.addChild({
		render: (width) => [truncateToWidth(ctx.theme.current.fg("accent", ctx.theme.current.bold(title)), width)],
		invalidate() {},
	});
	container.addChild(body);
	container.addChild({
		render: (width) => [truncateToWidth(ctx.theme.current.fg("dim", footer()), width, "…")],
		invalidate() {},
	});
	container.addChild(border);
	return container;
};

/** A few lines in every theme token family, rendered with the preview's own ThemeRef. */
function sample(ref: ThemeRef, width: number): string[] {
	const theme = ref.current;
	const markdown = new Markdown(
		"## Preview\nSome **bold** text, a [link](https://pi.dev) and `code`.\n```ts\nconst answer = 42; // comment\n```",
		1,
		0,
		ref.markdown,
	);
	return [
		...markdown.render(width),
		` ${theme.fg("toolDiffAdded", "+ added line")}  ${theme.fg("toolDiffRemoved", "- removed line")}`,
		` ${theme.fg("success", "success")} ${theme.fg("warning", "warning")} ${theme.fg("error", "error")} ${theme.fg("muted", "muted")} ${theme.fg("accent", "accent")}`,
		theme.bg("userMessageBg", ` ${theme.fg("userMessageText", "A user message")} `.padEnd(Math.max(1, width - 1))),
	];
}

/**
 * Theme picker: the list on the left in pi's look, the preview below it with its own ThemeRef, so the live transcript
 * keeps its theme until the patch is saved. "automatic" picks a light and a dark theme (pi's pair setting).
 */
export class ThemePicker implements Component, Focusable {
	focused = false;
	private readonly ctx: TuiContext;
	private list: SelectList;
	private preview: ThemeRef;
	private light: string | undefined;
	private readonly done: (value?: string) => void;
	constructor(ctx: TuiContext, current: string, done: (value?: string) => void) {
		this.ctx = ctx;
		this.done = done;
		this.preview = ctx.prefs.previewTheme(current);
		this.list = this.menu(current, "theme");
	}
	private menu(current: string, step: "theme" | "light" | "dark"): SelectList {
		const names = this.ctx.prefs.themeNames();
		const items: SelectItem[] = [
			...names.map((name) => ({
				value: name,
				label: `${name === current ? "✓ " : "  "}${lineText(name)}`,
				...(name === SYSTEM_THEME_NAME ? { description: "Theme created from your terminal's colors" } : {}),
			})),
			...(step === "theme"
				? [{ value: "/", label: "  automatic", description: "Separate themes for light and dark terminals" }]
				: []),
		];
		const list = new SelectList(items, 8, this.ctx.theme.selectList);
		const pair = parseAutoThemeSetting(current);
		const selected = items.findIndex((item) => item.value === (pair ? "/" : current));
		if (selected >= 0) list.setSelectedIndex(selected);
		list.onSelectionChange = (item) => {
			if (item.value !== "/") this.preview = this.ctx.prefs.previewTheme(item.value);
			this.ctx.requestRender();
		};
		list.onCancel = () => this.done();
		list.onSelect = (item) => {
			if (step === "theme" && item.value === "/")
				this.list = this.menu(pair?.lightTheme ?? SYSTEM_THEME_NAME, "light");
			else if (step === "light") {
				this.light = item.value;
				this.list = this.menu(pair?.darkTheme ?? item.value, "dark");
			} else if (step === "dark") this.done(`${this.light}/${item.value}`);
			else this.done(item.value);
			this.ctx.requestRender();
		};
		this.step = step;
		return list;
	}
	private step: "theme" | "light" | "dark" = "theme";
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
	render(width: number): string[] {
		const title = this.step === "light" ? "Light theme" : this.step === "dark" ? "Dark theme" : "Theme";
		return [
			truncateToWidth(this.ctx.theme.current.fg("accent", title), width),
			...this.list.render(width),
			...sample(this.preview, width),
		];
	}
	invalidate(): void {
		this.list.invalidate();
	}
}

/** `/settings`: pi's list; changes stay pending until the overlay closes, then go to the launcher as one patch. */
/** `/settings`: the built-in rows, then the plugins' `TuiSettingFields` rows in key order. */
export function openSettings(ctx: TuiContext, pluginFields: ReadonlyMap<string, TuiSettingField>): void {
	const settings = ctx.settings;
	const fields: Field[] = [
		...FIELDS,
		...[...pluginFields]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, field]) => ({
				id: `plugin:${key}`,
				label: field.label,
				description: field.description,
				path: ["plugins", field.plugin, field.name],
				fallback: field.fallback,
				values: [...field.values],
			})),
	];
	const patch: { settings: Record<string, unknown>; theme?: string } = { settings: {} };
	const set = (path: string[], value: Value) => {
		let target = patch.settings;
		for (const key of path.slice(0, -1)) {
			target[key] = (target[key] as Record<string, unknown> | undefined) ?? {};
			target = target[key] as Record<string, unknown>;
		}
		target[path.at(-1)!] = value;
	};
	const themeSetting = ctx.prefs.themeSetting ?? SYSTEM_THEME_NAME;
	const items: SettingItem[] = [
		{
			id: "theme",
			label: "Theme",
			description: "Color theme for the interface",
			currentValue: themeSetting,
			submenu: (current, done) => new ThemePicker(ctx, current, done),
		},
		...fields.map((field) => ({
			id: field.id,
			label: field.label,
			description: field.description,
			currentValue: String(read(settings, field.path) ?? field.fallback),
			values: field.values.map(String),
		})),
	];
	let changed = false;
	const finish = () => {
		overlay.close();
		if (!changed) return;
		const body = {
			...(Object.keys(patch.settings).length ? { settings: patch.settings } : {}),
			...(patch.theme ? { theme: patch.theme } : {}),
		};
		void ctx.prefs.save(body).then((result) => {
			if (result.ok) ctx.notify("Preferences saved; they apply as the launcher reloads them");
			else
				ctx.notify(
					result.error === "denied" ? "Preferences not saved" : `Preferences not saved (${result.error})`,
					"warning",
				);
		});
	};
	const list = new SettingsList(
		items,
		Math.min(items.length, 12),
		ctx.theme.settingsList,
		(id, value) => {
			changed = true;
			if (id === "theme") {
				patch.theme = value;
				return;
			}
			const field = fields.find((entry) => entry.id === id);
			if (!field) return;
			const typed = field.values.find((option) => String(option) === value);
			if (typed !== undefined) set(field.path, typed);
		},
		finish,
		{ enableSearch: true },
	);
	const framed = box(ctx, "Settings", list, () =>
		changed
			? "Esc saves the changes (the launcher shows them first)"
			: "Your TUI preferences on this computer · server settings: /model, /session",
	);
	const overlay = ctx.overlay(
		"settings",
		{
			render: (width) => framed.render(width),
			invalidate: () => framed.invalidate(),
			handleInput: (data) => list.handleInput(data),
		},
		{ width: "100%", anchor: "bottom-center" },
	);
}

/** Waits for one key and turns it into pi's key id (`ctrl+k`, `alt+enter`); Esc cancels. */
export class KeyCapture implements Component, Focusable {
	focused = false;
	private readonly ctx: TuiContext;
	private readonly title: string;
	private readonly current: string;
	private readonly done: (key: KeyId | [] | null | undefined) => void;
	private error = "";
	constructor(ctx: TuiContext, title: string, current: string, done: (key: KeyId | [] | null | undefined) => void) {
		this.ctx = ctx;
		this.title = title;
		this.current = current;
		this.done = done;
	}
	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const key = parseKey(data);
		if (key === "escape") this.done(undefined);
		else if (key === "backspace") this.done([]);
		else if (key === "delete") this.done(null);
		else if (key && isKeyId(key)) this.done(key);
		else {
			this.error = "That key cannot be bound";
			this.ctx.requestRender();
		}
	}
	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		const line = (text: string) => truncateToWidth(text, width, "…");
		return [
			theme.fg("border", "─".repeat(Math.max(1, width))),
			line(theme.fg("accent", theme.bold(`Rebind: ${lineText(this.title)}`))),
			line(`Current: ${this.current || "unbound"}`),
			line("Press the new key."),
			...(this.error ? [line(theme.fg("warning", this.error))] : []),
			line(theme.fg("dim", "Esc cancels · Backspace unbinds · Delete restores the default")),
			theme.fg("border", "─".repeat(Math.max(1, width))),
		];
	}
	invalidate(): void {}
}

/** `/keybindings`: every binding with its keys; Enter rebinds through `savePrefs`. Launcher-owned keys are listed only. */
export function openKeybindings(ctx: TuiContext): void {
	const definitions = builtinKeybindings();
	const rows = (): ListRow[] => {
		const commands = ctx.commands.list().map((item) => ({ id: item.id, title: item.command.title }));
		const known = new Set(commands.map((item) => item.id));
		const builtins = Object.entries(definitions)
			.filter(([id]) => !known.has(id) && (id.startsWith("tui.") || isPrivileged(id)))
			.map(([id, definition]) => ({ id, title: definition.description ?? id }));
		return [...commands, ...builtins].map(({ id, title }) => {
			const keys = formatKeyText(ctx.keys.getKeys(id).join("/")) || "unbound";
			return isPrivileged(id)
				? {
						key: id,
						label: lineText(title),
						detail: `${keys} · launcher-owned (edit keybindings.json)`,
						color: "muted" as const,
					}
				: { key: id, label: lineText(title), detail: keys };
		});
	};
	const close = () => overlay.close();
	const overlay = ctx.overlay(
		"keybindings",
		new ListOverlay(ctx, {
			title: "Keybindings",
			rows,
			onSelect: (row) => {
				if (isPrivileged(row.key)) {
					ctx.notify("Launcher-owned keys change only in your own keybindings.json", "warning");
					return;
				}
				const capture = ctx.overlay(
					"key-capture",
					new KeyCapture(ctx, row.label, row.detail ?? "", (key) => {
						capture.close();
						if (key === undefined) return;
						void ctx.prefs.save({ keybindings: { [row.key]: key } }).then((result) => {
							if (result.ok) ctx.notify("Keybinding saved; /hotkeys lists any conflict");
							else
								ctx.notify(
									result.error === "denied"
										? "Keybinding not saved"
										: `Keybinding not saved (${result.error})`,
									"warning",
								);
						});
					}),
					{ width: "100%", anchor: "bottom-center" },
				);
			},
			onClose: close,
			height: 14,
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}
