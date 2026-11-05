// The per-runtime context handed to TUI commands, overlays and (incrementally) surfaces: p2-tui-port.md sections
// 5.3, 6.3 and 7.2. Types only; TuiRuntime implements it as `runtime.ctx`.

import type {
	AutocompleteProvider,
	Component,
	Focusable,
	KeybindingsManager,
	KeyId,
	OverlayOptions,
} from "@earendil-works/pi-tui";
import type { PrivilegedResolution } from "../tui/keybindings.ts";
import type { RenderContext } from "../tui/render-context.ts";
import type { ThemeRef } from "../tui/theme/ref.ts";
import type { Host } from "./chord.ts";
import type { TuiCommand, TuiCommandConflict } from "./tui-commands.ts";
import type { TuiSettings } from "./tui-preferences.ts";

/** Key matching over dynamic (plugin) ids; the one place that casts strings to pi-tui's Keybinding union. */
export interface TuiKeys {
	/** The current manager (rebuilt whenever commands or preferences change; also installed via setKeybindings). */
	readonly manager: KeybindingsManager;
	matches(data: string, id: string): boolean;
	getKeys(id: string): KeyId[];
}

/** Copy of coding-agent components/keybinding-hints.ts over the instance keymap and theme. */
export interface TuiHints {
	/** "ctrl+o" style key text of a binding ("" when unbound). */
	keyText(id: string): string;
	/** Capitalized key text ("Ctrl+O"). */
	keyDisplayText(id: string): string;
	/** Dim keys + muted description, like pi's `keyHint`. */
	key(id: string, description: string): string;
	raw(key: string, description: string): string;
}

export interface TuiOverlayHandle {
	readonly id: string;
	close(): void;
	readonly closed: boolean;
}

export interface TuiPanelHandle {
	readonly id: string;
	close(): void;
	readonly closed: boolean;
}

/** The side panel next to the screen: one at a time, hidden on narrow terminals. */
export interface TuiPanel {
	/**
	 * Shows `content` in the panel under `title`, replacing what it showed (that content is disposed). The editor keeps
	 * the focus; `p2.panel.focus` moves it into the panel. Closed on navigation to another conversation and on reload.
	 */
	open(id: string, content: Component & { dispose?(): void }, title: () => string): TuiPanelHandle;
	/** Whether the terminal is wide enough to show the panel next to the screen. */
	readonly fits: boolean;
	/** The id of the panel's content, undefined when closed. */
	readonly current: string | undefined;
	/** Whether the panel has the focus (it keeps scroll keys; Escape gives the focus back). */
	readonly focused: boolean;
	/** Moves the focus into the panel or back to the screen. */
	focus(focused: boolean): void;
	close(): void;
}

/** Commands as seen from contexts: run by id, slash text, palette and help. */
export interface TuiCommandRunner {
	/** Runs a registered command if its `when` currently holds. Returns false if unknown or not applicable. */
	run(id: string, args?: string): boolean;
	/** Runs `/name args` through the slash-name index. Returns false if `text` names no enabled slash command. */
	runSlash(text: string): boolean;
	/** Whether `/name` is a template or skill from a `TuiSlashSources` entry (not a command). */
	expandable(name: string): boolean;
	/** The text to send for `/template args` or `/skill:name args` (expanded on the session worker), else `text`. */
	expand(text: string): Promise<string>;
	/** `/` completion over enabled slash names and their argument completers (section 6.3). */
	readonly autocomplete: AutocompleteProvider;
	palette(): void;
	hotkeys(): void;
	/** Registered commands (registration order), filtered to those applicable in `active` when given. */
	list(active?: ReadonlySet<string>): { id: string; command: TuiCommand; keys: KeyId[]; slash?: string }[];
	/** The active context set right now. */
	contexts(): ReadonlySet<string>;
	/** Conflicts, launcher-owned keys and preference problems for /hotkeys. */
	report(): {
		conflicts: readonly TuiCommandConflict[];
		privileged: PrivilegedResolution;
		unknown: readonly string[];
		problems: readonly string[];
	};
}

export type TuiRole = "owner" | "guest";
export interface TuiPrefsView {
	/** The effective theme setting (a name, "light/dark" pair, or undefined for the system theme). */
	readonly themeSetting: string | undefined;
	/** "system", the built-ins, then the visitor's custom themes. */
	themeNames(): string[];
	/** A separate ThemeRef for a picker's preview pane: the live theme never changes until the patch is saved. */
	previewTheme(setting: string): ThemeRef;
	/** Effective user keybindings (server defaults under the visitor's own). */
	readonly keybindings: Readonly<Record<string, unknown>>;
	/** Proposes a `prefs.json` patch to the launcher (`savePrefs`): it shows the diff and writes after confirmation. */
	save(patch: unknown): Promise<TuiGrantResult>;
}
export type TuiGrantResult = { ok: true; value?: unknown } | { ok: false; error: string };
export type TuiNoticeKind = "info" | "warning" | "error";

/**
 * Everything a TUI contribution may use. Planned members land with their phases (section 7.2): `editor`, `status`,
 * `working` (P2), `dialog` (P4), `grant` (P0b/P5).
 */
export interface TuiContext extends RenderContext {
	readonly host: Host;
	readonly theme: ThemeRef;
	readonly keys: TuiKeys;
	readonly hints: TuiHints;
	/** Guest-local display preferences (validated data from the launcher over server defaults). */
	readonly settings: TuiSettings;
	readonly role: TuiRole | undefined;
	/** The viewed session and conversation, and the session's main conversation (1, or its current `/tree` branch). */
	readonly identity: { readonly session: string | undefined; readonly conversation: number; readonly main: number };
	/** Shows a screen; with `conversation`, that conversation of the session (default: the main one on a switch). */
	navigate(screen: string, session?: string, conversation?: number): void;
	readonly view: { expandedTools: boolean; showThinking: boolean };
	readonly commands: TuiCommandRunner;
	/** A mounted surface by slot key (e.g. "chat"); commands use it to reach their plugin's live instance. */
	surface(name: string): Component | undefined;
	/** One status line (errors replace the runtime's error line until P2's status lines). */
	notify(message: string, kind?: TuiNoticeKind): void;
	/**
	 * Show an overlay on pi-tui's stack. While it is focused, commands whose `when` names `overlay` or `overlay:<id>`
	 * run before the component (section 6.2 stage 3). Closed on navigation, reload and plugin replacement.
	 */
	overlay(
		id: string,
		component: Component & Partial<Focusable> & { dispose?(): void },
		options?: OverlayOptions,
	): TuiOverlayHandle;
	readonly panel: TuiPanel;
	exit(): void;
	reload(): void;
	/**
	 * Asks the visitor's launcher for a C action (section 3.2), e.g. `openUrl`. The launcher shows its own consent UI
	 * with the exact data; only a local confirmation runs it. Resolves `{ok: false}` when denied, busy or cancelled.
	 */
	grant(action: string, payload?: unknown): Promise<TuiGrantResult>;
	/** The visitor's preferences as this runtime applies them (P10: /settings, the theme picker, /keybindings). */
	readonly prefs: TuiPrefsView;
}
