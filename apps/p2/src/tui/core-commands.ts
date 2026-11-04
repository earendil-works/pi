// Runtime-level commands (exit, reload, view toggles, palette, /hotkeys), contributed through the same TuiCommands
// registry as plugin commands so they are rebindable, listed and conflict-checked (p2-tui-port.md section 6.3).
// Like the header/footer fallbacks (section 7.1), the worker runtime always loads this facet.

import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeyId,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { defineFacet, serveKeyed } from "../runtime/chord.ts";
import { SHELL_ENTRY } from "../runtime/shell.ts";
import { TuiSlots } from "../runtime/tui.ts";
import { type TuiCommand, TuiCommands, TuiSlashSources } from "../runtime/tui-commands.ts";
import type { TuiContext } from "../runtime/tui-context.ts";
import {
	TuiEntryRenderers,
	TuiMarkdownTransformers,
	TuiToolRendererResolvers,
	TuiToolRenderers,
} from "../runtime/tui-renderers.ts";
import { TuiSessionPlaces, TuiSessionSources } from "../runtime/tui-sessions.ts";
import { shellEntryRenderer } from "./components/bash-execution.ts";
import { mermaidMarkdownTransformer } from "./components/mermaid.ts";
import { builtinKeybindings, PRIVILEGED_ACTIONS } from "./keybindings.ts";
import { formatKeyText } from "./render-context.ts";
import { openKeybindings, openSettings } from "./settings.ts";

/** Config locations as display text only: the worker never reads files (the launcher does). */
export const KEYBINDING_SOURCES = ["~/.pi/agent/keybindings.json", "~/.pi/p2-tui/prefs.json (keybindings)"];

const border = (ctx: TuiContext, width: number) => ctx.theme.current.fg("border", "─".repeat(Math.max(1, width)));

/** Command palette: fuzzy search over commands applicable in the context it was opened from. */
export class CommandPalette implements Component, Focusable {
	focused = false;
	private readonly input = new Input();
	private list!: SelectList;
	private readonly ctx: TuiContext;
	private readonly items: { id: string; title: string; detail: string }[];
	private readonly onDone: (id: string | undefined) => void;
	constructor(ctx: TuiContext, onDone: (id: string | undefined) => void) {
		this.ctx = ctx;
		this.onDone = onDone;
		const active = new Set([...ctx.commands.contexts()].filter((term) => !term.startsWith("overlay")));
		this.items = ctx.commands
			.list(active)
			.filter((item) => item.command.palette !== false && item.id !== "p2.palette")
			.map((item) => ({
				id: item.id,
				title: item.command.title,
				detail: [formatKeyText(item.keys.join("/")), item.slash && `/${item.slash}`, item.command.category]
					.filter(Boolean)
					.join(" · "),
			}));
		this.filter();
	}
	private filter(): void {
		const items = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.title} ${item.id} ${item.detail}`);
		this.list = new SelectList(
			items.map((item) => ({ value: item.id, label: item.title, description: item.detail })),
			10,
			this.ctx.theme.selectList,
		);
		this.list.onSelect = (item) => this.onDone(item.value);
		this.list.onCancel = () => this.onDone(undefined);
	}
	handleInput(data: string): void {
		const keys = this.ctx.keys;
		if (
			["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"].some((id) =>
				keys.matches(data, id),
			)
		)
			this.list.handleInput(data);
		else {
			this.input.handleInput(data);
			this.filter();
		}
	}
	render(width: number): string[] {
		this.input.focused = this.focused;
		const theme = this.ctx.theme.current;
		return [
			border(this.ctx, width),
			truncateToWidth(theme.fg("accent", "Commands"), width),
			...this.input.render(width),
			...this.list.render(width),
			border(this.ctx, width),
		];
	}
	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}
}

/** /hotkeys, generated from the registry: commands by category with contexts, launcher keys, conflicts, sources. */
export function hotkeysText(ctx: TuiContext): string[] {
	const report = ctx.commands.report();
	const theme = ctx.theme.current;
	const keys = (list: readonly KeyId[]) => (list.length ? formatKeyText(list.join("/")) : "unbound");
	const lines: string[] = [];
	const heading = (text: string) => lines.push("", theme.bold(theme.fg("accent", text)));
	const row = (left: string, right: string) => lines.push(`  ${theme.fg("dim", left.padEnd(26))} ${right}`);
	const byCategory = new Map<string, ReturnType<TuiContext["commands"]["list"]>>();
	for (const item of ctx.commands.list()) {
		const category = item.command.category ?? "General";
		byCategory.set(category, [...(byCategory.get(category) ?? []), item]);
	}
	for (const [category, items] of byCategory) {
		heading(category);
		for (const item of items)
			row(
				keys(item.keys),
				`${item.command.title}${item.slash ? theme.fg("muted", `  /${item.slash}${item.command.slash?.argumentHint ? ` ${item.command.slash.argumentHint}` : ""}`) : ""}${
					item.command.when ? theme.fg("muted", `  [${item.command.when}]`) : ""
				}`,
			);
	}
	const definitions = builtinKeybindings();
	// Keys of prompts that are not commands (owner): where a session runs, as the footer writes it.
	if (ctx.role === "owner") {
		heading("Working directory and environment");
		row(
			keys(ctx.keys.getKeys("tui.input.tab")),
			"New-session and /cd prompts: next environment (this device, then /envs)",
		);
		row("[env:]path", "As the footer shows it: gpu:/data on an environment, /data on this device");
		row("/cd [[env:]path]", "Relative to the session's directory; Tab completes folders; local: is this device");
		row(
			"/envs",
			"Enter moves the session to the environment (● marks its current one); Ctrl+T test, Ctrl+K host key, Ctrl+F forget",
		);
	}
	heading("Editor and transcript (pi-tui)");
	for (const id of Object.keys(definitions).filter(
		(id) => id.startsWith("tui.editor.") || id.startsWith("tui.altScreen."),
	))
		row(keys(ctx.keys.getKeys(id)), definitions[id]?.description ?? id);
	heading("Launcher-owned (handled by your local launcher, never by server code)");
	for (const id of PRIVILEGED_ACTIONS) row(keys(report.privileged.keys[id] ?? []), definitions[id]?.description ?? id);
	if (report.conflicts.length || report.unknown.length || report.problems.length) {
		heading("Conflicts and problems");
		for (const conflict of report.conflicts) lines.push(`  ${theme.fg("warning", conflict.message)}`);
		for (const id of report.unknown) lines.push(`  ${theme.fg("warning", `Unknown keybinding id kept: ${id}`)}`);
		for (const problem of report.problems) lines.push(`  ${theme.fg("warning", problem)}`);
	}
	heading("Configuration");
	lines.push(
		`  ${theme.fg("muted", `Keybindings: ${KEYBINDING_SOURCES.join(", then ")}; server defaults apply below them.`)}`,
	);
	return lines.slice(1);
}

/** Scrollable read-only text overlay. */
export class TextOverlay implements Component, Focusable {
	focused = false;
	private offset = 0;
	private readonly ctx: TuiContext;
	private readonly title: string;
	private readonly lines: () => string[];
	private readonly onClose: () => void;
	constructor(ctx: TuiContext, title: string, lines: () => string[], onClose: () => void) {
		this.ctx = ctx;
		this.title = title;
		this.lines = lines;
		this.onClose = onClose;
	}
	private height(): number {
		return 18;
	}
	handleInput(data: string): void {
		const keys = this.ctx.keys;
		const max = Math.max(0, this.lines().length - this.height());
		if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) this.onClose();
		else if (keys.matches(data, "tui.select.up")) this.offset = Math.max(0, this.offset - 1);
		else if (keys.matches(data, "tui.select.down")) this.offset = Math.min(max, this.offset + 1);
		else if (keys.matches(data, "tui.select.pageUp")) this.offset = Math.max(0, this.offset - this.height());
		else if (keys.matches(data, "tui.select.pageDown")) this.offset = Math.min(max, this.offset + this.height());
	}
	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		const all = this.lines();
		const visible = all.slice(this.offset, this.offset + this.height());
		return [
			border(this.ctx, width),
			truncateToWidth(theme.fg("accent", this.title), width),
			...visible.map((line) => truncateToWidth(line, width)),
			truncateToWidth(
				theme.fg(
					"dim",
					`${this.offset + 1}-${this.offset + visible.length} of ${all.length} · ↑↓ PgUp/PgDn · Esc closes`,
				),
				width,
			),
			border(this.ctx, width),
		];
	}
	invalidate(): void {}
}

export const CORE_COMMANDS: Record<string, TuiCommand> = {
	"p2.palette": {
		title: "Command palette",
		category: "General",
		keys: "f1",
		when: "!overlay",
		palette: false,
		run: (ctx) => {
			const handle = ctx.overlay(
				"palette",
				new CommandPalette(ctx, (id) => {
					handle.close();
					if (id) ctx.commands.run(id);
				}),
				{ width: "70%", anchor: "top-center", offsetY: 2 },
			);
		},
	},
	"p2.hotkeys": {
		title: "Keyboard shortcuts",
		category: "General",
		slash: { name: "hotkeys" },
		when: "!overlay",
		run: (ctx) => {
			const handle = ctx.overlay(
				"hotkeys",
				new TextOverlay(
					ctx,
					"Keyboard shortcuts",
					() => hotkeysText(ctx),
					() => handle.close(),
				),
				{ width: "90%", anchor: "top-center", offsetY: 1 },
			);
		},
	},
	// P10: the visitor's own preferences; saved by the launcher (savePrefs) after it shows the diff.
	"p2.settings": {
		title: "Settings",
		category: "General",
		slash: { name: "settings" },
		when: "!overlay",
		run: (ctx) => openSettings(ctx),
	},
	"p2.keybindings": {
		title: "Rebind keys",
		category: "General",
		slash: { name: "keybindings" },
		when: "!overlay",
		run: (ctx) => openKeybindings(ctx),
	},
	"app.exit": {
		title: "Exit",
		category: "General",
		// pi: Ctrl+D exits only on an empty editor; otherwise the editor deletes forward.
		when: "!overlay && (!editorFocused || editorEmpty)",
		slash: { name: "quit" },
		run: (ctx) => ctx.exit(),
	},
	"p2.tui.reload": {
		title: "Reload the TUI from the server",
		category: "General",
		slash: { name: "reload" },
		run: (ctx) => ctx.reload(),
	},
	"app.tools.expand": {
		title: "Toggle tool output",
		category: "View",
		when: "!overlay",
		run: (ctx) => {
			ctx.view.expandedTools = !ctx.view.expandedTools;
		},
	},
	"app.thinking.toggle": {
		title: "Toggle thinking blocks",
		category: "View",
		when: "!overlay",
		run: (ctx) => {
			ctx.view.showThinking = !ctx.view.showThinking;
		},
	},
};

/**
 * The facet the worker runtime always loads (tests load it next to plugin facets): it serves the TUI's registries and
 * contributes the core commands and renderers.
 */
export const tuiCoreFacet = defineFacet((host, self) => {
	serveKeyed(host, TuiSlots);
	serveKeyed(host, TuiCommands);
	serveKeyed(host, TuiSlashSources);
	serveKeyed(host, TuiToolRenderers);
	serveKeyed(host, TuiToolRendererResolvers);
	serveKeyed(host, TuiSessionSources);
	serveKeyed(host, TuiSessionPlaces);
	serveKeyed(host, TuiEntryRenderers);
	serveKeyed(host, TuiMarkdownTransformers);
	self.contribute(TuiCommands, CORE_COMMANDS);
	// pi's built-in transformer, ahead of plugin transformers ("10:…").
	self.contribute(TuiMarkdownTransformers, { "00:mermaid": mermaidMarkdownTransformer });
	// The host's user shell entries (`!cmd`, src/runtime/shell.ts) as pi's bash execution component.
	self.contribute(TuiEntryRenderers, { [SHELL_ENTRY]: shellEntryRenderer });
});
