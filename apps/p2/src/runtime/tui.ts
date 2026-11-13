import type { Contract, Held, ParamsOf } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { TuiScope as ChordTuiScope, type OptimisticAdd } from "@earendil-works/chord/tui";
import type { NativeWatchable, Watchable } from "@earendil-works/chord/watch";
import {
	type Component,
	type Focusable,
	HStack,
	type KeybindingsManager,
	type OverlayHandle,
	type OverlayOptions,
	Text,
	type TUI,
	VStack,
} from "@earendil-works/pi-tui";
import { BuiltInFooter, BuiltInHeader, type Notice, StatusLines } from "../tui/components/chrome.ts";
import { type PanelContent, PanelFrame } from "../tui/components/panel.ts";
import type { TranscriptAnchor } from "../tui/components/transcript.ts";
import { formatKeyText, lineText } from "../tui/render-context.ts";
import { ThemeRef } from "../tui/theme/ref.ts";
import { BUILTIN_THEMES, resolveTheme, SYSTEM_THEME_NAME, type Theme } from "../tui/theme/theme.ts";
import { defineFacet, type FacetHost, type Host, keyedRegistry } from "./chord.ts";
import type { P2Principal } from "./principals.ts";
import { follow, UI_LINGER } from "./refs.ts";
import { TuiAppearance } from "./tui-appearance.ts";
import { type TuiCommand, TuiCommandDispatcher, TuiCommands, TuiSlashSources } from "./tui-commands.ts";
import type { TuiContext, TuiGrantResult, TuiOverlayHandle, TuiPanelHandle, TuiRole } from "./tui-context.ts";

export interface TuiSurface extends Component {
	dispose(): void;
	focus?: Component & Focusable;
	command?(name: string): void;
	/** Context terms while this is the active screen (section 6.3), e.g. `editorFocused`, `editorEmpty`, `busy`. */
	contexts?(): Iterable<string>;
	/**
	 * Fullscreen layout (P0c): a body that fills the screen (the chat's transcript ScrollView, which carries the header)
	 * and a part docked under it (pending area, editor). Without it, the header and the surface fill the body.
	 */
	layout?(): { body: Component; dock?: Component; header?: false };
	/** Writes UI state kept by the runtime (the reading position) before a reload snapshot. */
	saveState?(): void;
}

/** A viewed conversation: drafts, submissions and reading positions are kept per identity (P0c). */
export const identityKey = (session: string, conversation = 1): string => `${session}#${conversation}`;
export type TuiFactory = (runtime: TuiRuntime) => TuiSurface;
export const TuiSlots = keyedRegistry<TuiFactory>("p2.tui-slots");
/**
 * A TUI facet: one slot and, optionally, its commands (section 7.1); `setup` declares what else it serves (a registry
 * its plugin defines).
 */
export function tuiFacet(
	name: string,
	factory: TuiFactory,
	commands: Record<string, TuiCommand> = {},
	setup?: (host: FacetHost) => void,
) {
	return defineFacet((host, self) => {
		setup?.(host);
		self.contribute(TuiSlots, { [name]: factory });
		if (Object.keys(commands).length) self.contribute(TuiCommands, commands);
	});
}

export type { OptimisticAdd } from "@earendil-works/chord/tui";

/** What `TuiScope.watch`'s bind follows: a member of the live reference (a state member, a derive). */
export type TuiFollow = <T>(source: Watchable<T> | NativeWatchable<T>, fn: (value: T) => void) => void;

/**
 * Component-owned references: each is held until the scope is disposed (then released after its type's linger), its
 * members followed from its first live binding. Chord rebinds a held reference by itself (a dropped link, a restarted
 * worker, a reload), so the scope only reports what it cannot fix: a broken failure or an end.
 */
export class TuiScope {
	private stops: (() => void)[] = [];
	readonly runtime: TuiRuntime;
	/** Chord's scope, for its optimistic readers: they redraw the runtime and stop with this scope. */
	readonly #optimistic: ChordTuiScope<P2Principal>;
	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		this.#optimistic = new ChordTuiScope(runtime.host, () => runtime.changed());
	}
	watch<C extends Contract>(type: C, params: ParamsOf<C>, bind: (ref: Held<C>, follow: TuiFollow) => void): Held<C> {
		// Synchronous: the scope renders loading from the reference's state.
		const ref = this.runtime.host.hold(type, params, BACKGROUND_CONTEXT);
		let bound = false;
		const stops: (() => void)[] = [];
		stops.push(
			follow(ref.state, (state) => {
				this.runtime.changed();
				if (state.kind === "live" && !bound) {
					bound = true;
					bind(ref, (source, fn) => {
						stops.push(
							follow(source, (value) => {
								fn(value);
								this.runtime.changed();
							}),
						);
					});
				} else if (state.kind === "failed" && state.cause.kind === "broken") this.runtime.fail(state.cause.error);
				else if (state.kind === "ended") this.runtime.fail(state.error);
			}),
		);
		this.stops.push(() => {
			for (const stop of stops) stop();
			UI_LINGER.release(ref, type.name);
		});
		return ref;
	}
	/**
	 * Optimistic UI in the terminal (docs/optimistic-ui.md): Chord's `TuiScope.optimistic`, React's `useOptimistic`, on
	 * this scope (redrawing the runtime). `add(action, call)` returns the call: its failure is the caller's to show
	 * (`runtime.perform`), and its action goes as a settled one's does.
	 */
	optimistic<T>(read: () => T): readonly [read: () => T, add: OptimisticAdd<T>, pending: () => boolean];
	optimistic<T, A>(
		read: () => T,
		reduce: (current: T, action: A) => T,
	): readonly [read: () => T, add: OptimisticAdd<A>, pending: () => boolean];
	optimistic<T, A>(read: () => T, reduce?: (current: T, action: A) => T) {
		return reduce ? this.#optimistic.optimistic(read, reduce) : this.#optimistic.optimistic(read);
	}
	dispose(): void {
		for (const stop of this.stops.splice(0)) stop();
		this.#optimistic.dispose();
	}
}

/** Below this many columns the side panel is hidden: the chat would be too narrow next to it. */
const PANEL_MIN_COLUMNS = 100;

/** Host UI state stays outside replaceable facets: selection, drafts and scroll position survive reload. */
export class TuiRuntime implements Component, Focusable {
	private isFocused = false;
	get focused(): boolean {
		return this.isFocused;
	}
	/** The runtime is pi-tui's focused component; it forwards focus (cursor) to the active surface. */
	set focused(value: boolean) {
		this.isFocused = value;
		const focus = this.surfaces?.get(this.screen)?.focus;
		if (focus) focus.focused = value && !this.panelFocused;
	}
	/** While the panel has the focus, pi-tui's viewport keys come here (to scroll it) instead of the transcript. */
	get capturesViewportInput(): boolean {
		return this.panelFocused;
	}
	/** This TUI's own name (`tui:<uuid>`): the viewer it counts as in session metrics. */
	readonly name = `tui:${crypto.randomUUID()}`;
	session: string | undefined;
	conversation = 1;
	/** Each session's main conversation (1, or its current `/tree` branch), as the sessions plugin last saw its row. */
	readonly mains = new Map<string, number>();
	screen: "sessions" | "chat" | "models" = "sessions";
	connected = false;
	showThinking = false;
	/**
	 * The `hideThinkingBlock` setting (unset = hidden) that `showThinking` last followed. The toggle command overrides
	 * it until the setting itself changes; a reload snapshot carries both, so a reload keeps the toggle.
	 */
	thinkingSetting = true;
	expandedTools = false;
	/** The server origin (from the launcher), shown in the header. */
	origin: string | undefined;
	/** Keyed by `identityKey(session, conversation)`. */
	readonly drafts = new Map<string, string>();
	readonly submissions = new Map<string, { text: string; id: string; mode: "steer" | "followUp" }>();
	/** Reading positions by identity; absent = following the end. Kept across switches and reloads. */
	readonly anchors = new Map<string, TranscriptAnchor>();
	/** Status lines (newest last), cleared on navigation. */
	notices: Notice[] = [];
	readonly listeners = new Set<() => void>();
	/** The layout root (TuiAltScreen.setLayoutRoot): body over dock, rebuilt when the screen or its surface changes. */
	readonly root = new VStack();
	private rootParts: unknown[] = [];
	private builtInHeader: BuiltInHeader;
	private builtInFooter: BuiltInFooter;
	private statusLines: StatusLines;
	private placeholder = new Text("Loading TUI facets…", 1, 0);
	private surfaces = new Map<string, TuiSurface>();
	private factories = new Map<string, TuiFactory>();
	private stopRegistry: (() => void) | undefined;
	private stopCommands: (() => void) | undefined;
	private changing = false;
	private overlays: { id: string; handle: OverlayHandle; close(): void }[] = [];
	private panel: PanelFrame | undefined;
	private panelFocused = false;
	onExit: () => void = () => {};
	onReload: () => void = () => {};
	/** The launcher bridge for C actions (set by the worker runtime); denied without one (tests, bare hosts). */
	onGrant: (action: string, payload: unknown) => Promise<TuiGrantResult> = async () => ({
		ok: false,
		error: "unavailable",
	});
	/** Answers launcher questions bound to a grant (e.g. P5's `copyText`); unknown questions get null. */
	readonly launcherAnswers = new Map<string, (payload: unknown) => unknown>();
	role: TuiRole | undefined;
	/** A guest's share grant (name as the guest typed it, the sessions shared with it), from `Access`. */
	grant: { name: string; sessions: Readonly<Record<string, "view" | "full">> } | undefined;
	/** A guest's mode in the session it views; undefined for the owner or outside a shared session. */
	guestMode(): "view" | "full" | undefined {
		return this.session === undefined ? undefined : this.grant?.sessions[this.session];
	}
	readonly host: Host;
	readonly tui: TUI;
	/** Guest-local preferences, terminal colors and the instance theme (sections 4.2, 5.3). */
	readonly appearance: TuiAppearance;
	/** Command registry dispatcher and the current keymap (section 6). */
	readonly commands: TuiCommandDispatcher;
	readonly ctx: TuiContext;
	constructor(host: Host, tui: TUI, options: { theme?: Theme } = {}) {
		this.host = host;
		this.tui = tui;
		this.commands = new TuiCommandDispatcher({
			ctx: () => this.ctx,
			contexts: () => this.contexts(),
			exclusive: () => [this.screens(), ["owner", "guest"]],
			onError: (error) => this.fail(error),
		});
		this.appearance = new TuiAppearance((appearance) => {
			this.commands.setUserBindings(appearance.keybindings, appearance.keyPlatform);
			const hide = appearance.settings.hideThinkingBlock ?? true;
			if (hide !== this.thinkingSetting) {
				this.thinkingSetting = hide;
				this.showThinking = !hide;
			}
			this.tui.invalidate();
			this.changed();
			this.tui.requestRender(true);
		}, options.theme);
		this.ctx = this.createContext();
		const runtime = this;
		this.builtInHeader = new BuiltInHeader({
			ctx: this.ctx,
			get origin() {
				return runtime.origin;
			},
			// Section 4.1: "guest · <name> (unverified) · view|full" once Access names the grant.
			get role() {
				const grant = runtime.grant;
				return runtime.role === "guest" && grant
					? `guest · ${lineText(grant.name).slice(0, 40)} (unverified) · ${runtime.guestMode() === "full" ? "full access" : "view only"}`
					: runtime.role;
			},
			get connected() {
				return runtime.connected;
			},
			get expanded() {
				return runtime.expandedTools;
			},
			hints: () => this.headerHints(false),
			expandedHints: () => this.headerHints(true),
		});
		this.builtInFooter = new BuiltInFooter(() => this.helpLine());
		this.statusLines = new StatusLines(this.ctx, () => this.notices);
	}
	/** Drafts, submissions and anchors of the viewed conversation are stored under this key. */
	get identity(): string | undefined {
		return this.session === undefined ? undefined : identityKey(this.session, this.conversation);
	}
	/** The header: a plugin's `header` slot, else the built-in one. Chat shows it at the top of its transcript. */
	get header(): Component {
		return this.surfaces.get("header") ?? this.builtInHeader;
	}
	/** Adds a status line; an identical last line collapses into a count (pi's showStatus). */
	notify(message: string, kind: Notice["kind"] = "info"): void {
		const text = lineText(message);
		const last = this.notices.at(-1);
		if (last && last.text === text && last.kind === kind) last.count++;
		else this.notices = [...this.notices, { kind, text, count: 1 }].slice(-3);
		this.changed();
	}
	/** Mounted slot surfaces whose key starts with `prefix` (`composer:` chips, section 7.2), in key order. */
	slots(prefix: string): TuiSurface[] {
		return [...this.surfaces]
			.filter(([name]) => name.startsWith(prefix))
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([, surface]) => surface);
	}
	/** Lets surfaces store what a reload snapshot carries (see src/tui/snapshot.ts). */
	saveState(): void {
		for (const surface of this.surfaces.values()) surface.saveState?.();
	}
	clearNotices(): void {
		if (this.notices.length === 0) return;
		this.notices = [];
		this.changed();
	}
	/** The current keymap; rebuilt (and installed with setKeybindings) when commands or preferences change. */
	get keys(): KeybindingsManager {
		return this.commands.manager;
	}
	get theme(): ThemeRef {
		return this.appearance.theme;
	}
	private createContext(): TuiContext {
		const runtime = this;
		const keyText = (id: string) => formatKeyText(runtime.commands.getKeys(id).join("/"));
		return {
			host: runtime.host,
			get theme() {
				return runtime.theme;
			},
			keys: {
				get manager() {
					return runtime.commands.manager;
				},
				matches: (data, id) => runtime.commands.matches(data, id),
				getKeys: (id) => runtime.commands.getKeys(id),
			},
			keyText,
			hints: {
				keyText,
				keyDisplayText: (id) => formatKeyText(runtime.commands.getKeys(id).join("/"), { capitalize: true }),
				key: (id, description) =>
					runtime.theme.current.fg("dim", keyText(id)) + runtime.theme.current.fg("muted", ` ${description}`),
				raw: (key, description) =>
					runtime.theme.current.fg("dim", formatKeyText(key)) +
					runtime.theme.current.fg("muted", ` ${description}`),
			},
			requestRender: () => runtime.tui.requestRender(),
			get settings() {
				return runtime.appearance.settings;
			},
			get role() {
				return runtime.role;
			},
			get identity() {
				return {
					session: runtime.session,
					conversation: runtime.conversation,
					main: runtime.mainOf(runtime.session),
				};
			},
			navigate: (screen, session, conversation) =>
				runtime.navigate(screen as TuiRuntime["screen"], session ?? runtime.session, conversation),
			view: {
				get expandedTools() {
					return runtime.expandedTools;
				},
				set expandedTools(value) {
					runtime.expandedTools = value;
					runtime.changed();
				},
				get showThinking() {
					return runtime.showThinking;
				},
				set showThinking(value) {
					runtime.showThinking = value;
					runtime.changed();
				},
			},
			commands: {
				run: (id, args) => runtime.commands.run(id, args),
				runSlash: (text) => runtime.commands.runSlash(text),
				expandable: (name) => runtime.commands.slashEntries().some(({ entry }) => entry.name === name),
				expand: (text) => runtime.commands.expand(text),
				get autocomplete() {
					return runtime.commands.autocomplete;
				},
				palette: () => runtime.commands.run("p2.palette"),
				hotkeys: () => runtime.commands.run("p2.hotkeys"),
				list: (active) => runtime.commands.list(active),
				contexts: () => runtime.contexts(),
				report: () => ({
					conflicts: runtime.commands.conflicts,
					privileged: runtime.commands.privileged,
					unknown: runtime.commands.unknown,
					problems: [
						...runtime.appearance.local.problems,
						...(runtime.appearance.themeError ? [runtime.appearance.themeError] : []),
					],
				}),
			},
			surface: (name) => runtime.surfaces.get(name),
			notify: (message, kind) => runtime.notify(message, kind),
			fail: (error) => runtime.fail(error),
			perform: (action) => runtime.perform(action),
			scope: () => new TuiScope(runtime),
			overlay: (id, component, options) => runtime.overlay(id, component, options),
			panel: {
				open: (id, content, title) => runtime.openPanel(id, content, title),
				get fits() {
					return runtime.panelFits();
				},
				get current() {
					return runtime.panel?.id;
				},
				get focused() {
					return runtime.panelFocused;
				},
				focus: (focused) => runtime.focusPanel(focused),
				close: () => runtime.closePanel(),
			},
			exit: () => runtime.onExit(),
			grant: (action, payload) => runtime.onGrant(action, payload),
			prefs: {
				get themeSetting() {
					return runtime.appearance.themeSetting;
				},
				themeNames: () => [
					SYSTEM_THEME_NAME,
					...Object.keys(BUILTIN_THEMES),
					...Object.keys(runtime.appearance.local.themes).filter(
						(name) => name !== SYSTEM_THEME_NAME && !(name in BUILTIN_THEMES),
					),
				],
				previewTheme: (setting) =>
					new ThemeRef(
						resolveTheme({
							setting,
							themes: runtime.appearance.local.themes,
							mode: runtime.appearance.colorMode,
							terminal: runtime.appearance.terminal,
						}).theme,
					),
				get keybindings() {
					return runtime.appearance.keybindings;
				},
				save: (patch) => runtime.onGrant("savePrefs", { patch }),
			},
			reload: () => runtime.onReload(),
		};
	}
	/** Screen slots are mutually exclusive context terms. */
	private screens(): string[] {
		return [...new Set(["sessions", "chat", "models", ...this.factories.keys()])].filter(
			(name) => name !== "status" && name !== "header" && name !== "footer" && !name.includes(":"),
		);
	}
	/** The active context set (section 6.3): screen, role, overlay, and the active screen's own terms. */
	contexts(): Set<string> {
		const active = new Set<string>([this.screen]);
		if (this.role) active.add(this.role);
		if (this.connected) active.add("connected");
		const top = this.overlays.findLast((overlay) => overlay.handle.isFocused());
		if (top) active.add("overlay").add(`overlay:${top.id}`);
		if (this.panelShown()) active.add("panel");
		if (this.panelFocused) active.add("panelFocused");
		for (const term of this.surfaces.get(this.screen)?.contexts?.() ?? []) active.add(term);
		return active;
	}
	/** Shows a pi-tui overlay whose focused input passes overlay-scoped commands first (section 6.2 stage 3). */
	overlay(
		id: string,
		component: Component & Partial<Focusable> & { dispose?(): void },
		options?: OverlayOptions,
	): TuiOverlayHandle {
		const wrapper: Component & Focusable = {
			get focused() {
				return component.focused ?? false;
			},
			set focused(value) {
				if ("focused" in component) component.focused = value;
			},
			render: (width) => component.render(width),
			invalidate: () => component.invalidate(),
			handleInput: (data) => {
				if (!this.commands.dispatch(data)) component.handleInput?.(data);
				this.tui.requestRender();
			},
		};
		let closed = false;
		const record = {
			id,
			handle: this.tui.showOverlay(wrapper, options),
			close: () => {
				if (closed) return;
				closed = true;
				record.handle.hide();
				this.overlays = this.overlays.filter((overlay) => overlay !== record);
				// However it closes (its own action, navigation, reload, plugin replacement), it releases what it holds.
				component.dispose?.();
				this.changed();
			},
		};
		this.overlays.push(record);
		this.changed();
		return {
			id,
			close: record.close,
			get closed() {
				return closed;
			},
		};
	}
	closeOverlays(): void {
		for (const overlay of [...this.overlays].reverse()) overlay.close();
	}
	/** Shows `content` in the side panel, replacing (and disposing) what it showed. */
	openPanel(id: string, content: PanelContent, title: () => string): TuiPanelHandle {
		this.closePanel();
		const frame = new PanelFrame(this.ctx, id, content, title);
		this.panel = frame;
		this.changed();
		const runtime = this;
		return {
			id,
			close: () => {
				if (this.panel === frame) this.closePanel();
			},
			get closed() {
				return runtime.panel !== frame;
			},
		};
	}
	closePanel(): void {
		const frame = this.panel;
		if (!frame) return;
		this.panel = undefined;
		this.focusPanel(false);
		frame.content.dispose?.();
		this.changed();
	}
	/** Moves the focus into the panel (`true`) or back to the screen; a hidden or closed panel never takes it. */
	focusPanel(focused: boolean): void {
		const next = focused && this.panelShown();
		if (next === this.panelFocused) return;
		this.panelFocused = next;
		if (this.panel) this.panel.focused = next;
		this.focused = this.isFocused;
		this.changed();
	}
	/** Whether the panel is open and the terminal wide enough to show it. */
	private panelShown(): boolean {
		return this.panel !== undefined && this.panelFits();
	}
	private panelFits(): boolean {
		return this.tui.terminal.columns >= PANEL_MIN_COLUMNS;
	}
	/** Keys for the focused panel: back to the screen, scrolling; false for keys it does not use. */
	private panelInput(data: string, scroll: PanelFrame["scroll"]): boolean {
		const page = Math.max(1, scroll.viewportHeight - 1);
		const half = Math.max(1, Math.floor(scroll.viewportHeight / 2));
		const steps: [string, number][] = [
			["tui.altScreen.pageUp", -page],
			["tui.altScreen.pageDown", page],
			["tui.select.pageUp", -page],
			["tui.select.pageDown", page],
			["tui.altScreen.halfPageUp", -half],
			["tui.altScreen.halfPageDown", half],
			["tui.altScreen.lineUp", -1],
			["tui.altScreen.lineDown", 1],
			["tui.select.up", -1],
			["tui.select.down", 1],
		];
		if (this.commands.matches(data, "tui.select.cancel")) this.focusPanel(false);
		else if (this.commands.matches(data, "tui.altScreen.top")) scroll.scrollToStart();
		else if (this.commands.matches(data, "tui.altScreen.bottom")) scroll.scrollToEnd();
		else {
			const step = steps.find(([id]) => this.commands.matches(data, id));
			if (!step) return false;
			scroll.scrollBy(step[1]);
		}
		return true;
	}
	/** Follows the slot, command and slash registries (once the host published them). */
	async start(): Promise<void> {
		const [sources, commands, slots] = await Promise.all([
			this.host.registry(TuiSlashSources, BACKGROUND_CONTEXT),
			this.host.registry(TuiCommands, BACKGROUND_CONTEXT),
			this.host.registry(TuiSlots, BACKGROUND_CONTEXT),
		]);
		const stopSources = follow(sources, (table) => this.commands.setSources(table));
		const stopCommands = follow(commands, (table) => {
			// A facet reload replaces command values: overlays and the panel opened by old values close (section 7.1).
			this.closeOverlays();
			this.closePanel();
			this.commands.setCommands(table);
			this.changed();
		});
		this.stopCommands = () => {
			stopSources();
			stopCommands();
		};
		this.stopRegistry = follow(slots, (table) => {
			for (const [name, surface] of this.surfaces)
				if (table.get(name) !== this.factories.get(name)) {
					surface.dispose();
					this.surfaces.delete(name);
				}
			this.factories = new Map(table);
			this.changing = true;
			try {
				for (const [name, factory] of table) if (!this.surfaces.has(name)) this.surfaces.set(name, factory(this));
			} finally {
				this.changing = false;
			}
			this.changed();
		});
	}
	changed(): void {
		if (this.changing) return;
		for (const listener of this.listeners) listener();
		this.syncLayout();
		this.tui.requestRender();
	}
	/** Body over dock (coding-agent chat-viewport.ts): rebuilt only when the screen, its surface or a slot changed. */
	private syncLayout(): void {
		const surface = this.surfaces.get(this.screen);
		const layout = surface?.layout?.();
		const footer = this.surfaces.get("footer") ?? this.builtInFooter;
		const parts = [surface, layout?.body, layout?.dock, layout?.header, footer, this.header, this.panel];
		for (const [name, other] of this.surfaces)
			if (other.focus) other.focus.focused = name === this.screen && this.focused && !this.panelFocused;
		if (parts.length === this.rootParts.length && parts.every((part, index) => part === this.rootParts[index]))
			return;
		this.rootParts = parts;
		this.root.clear();
		const body = layout
			? layout.body
			: new VStack([
					{ component: this.header, basis: "auto", shrink: 1, minSize: 0 },
					{ component: surface ?? this.placeholder, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				]);
		this.root.addChild(this.panel ? this.besidePanel(body, this.panel) : body, {
			basis: 0,
			grow: 1,
			shrink: 1,
			minSize: 1,
		});
		const dock = new VStack([
			{ component: this.statusLines, shrink: 1, minSize: 0 },
			...(layout?.dock ? [{ component: layout.dock, shrink: 1, minSize: 3 }] : []),
			{ component: footer, shrink: 1, minSize: 0 },
		]);
		this.root.addChild(dock, { basis: "auto", grow: 0, shrink: 1, minSize: 1 });
		this.tui.invalidate();
	}
	/** The screen's body with the panel on its right (about 40% of the width); the panel hides on narrow terminals. */
	private besidePanel(body: Component, panel: PanelFrame): Component {
		return new HStack(
			[
				{ component: body, basis: 0, grow: 3, shrink: 1, minSize: 40 },
				{
					component: panel.root,
					basis: 0,
					grow: 2,
					shrink: 1,
					minSize: 40,
					visible: (viewport) => viewport.width >= PANEL_MIN_COLUMNS,
				},
			],
			{ gap: 1 },
		);
	}
	fail(error: unknown): void {
		this.notify(error instanceof Error ? error.message : String(error), "error");
	}
	perform(action: Promise<unknown>): void {
		void action.catch((error: unknown) => this.fail(error));
	}
	/** The main conversation of `session` (1 until its row is known). */
	mainOf(session: string | undefined): number {
		return (session === undefined ? undefined : this.mains.get(session)) ?? 1;
	}
	/**
	 * Shows a screen; a session or conversation change switches the viewed identity (overlays close). Another session
	 * opens at its main conversation.
	 */
	navigate(screen: TuiRuntime["screen"], session = this.session, conversation?: number): void {
		const next = conversation ?? (session === this.session ? this.conversation : this.mainOf(session));
		const changed = session !== this.session || next !== this.conversation;
		if (changed) {
			this.closeOverlays();
			this.closePanel();
		}
		this.session = session;
		this.conversation = next;
		this.screen = screen;
		this.notices = [];
		this.changed();
	}
	handleInput(data: string): void {
		// Section 6.2: the alt screen (stage 2) already ran; commands by context (stage 4), then the screen (stage 5).
		// A focused panel takes its keys first and never passes the rest to the screen (typing stays out of the editor).
		const panel = this.panelFocused && this.panelShown() ? this.panel : undefined;
		if (this.panelFocused && !panel) this.focusPanel(false);
		if (panel) {
			if (this.panelInput(data, panel.scroll) || this.commands.dispatch(data)) this.changed();
		} else if (this.commands.dispatch(data)) this.changed();
		else this.surfaces.get(this.screen)?.handleInput?.(data);
		this.tui.requestRender();
	}
	invalidate(): void {
		this.builtInHeader.invalidate();
		for (const surface of this.surfaces.values()) surface.invalidate();
	}
	/** The layout root's lines without a viewport (tests); the terminal renders `root` through TuiAltScreen. */
	render(width: number): string[] {
		this.syncLayout();
		// Every part at its natural height (a VStack without a viewport gives the body its zero basis).
		return this.root.children.flatMap((child) =>
			child instanceof VStack ? child.children.flatMap((part) => part.render(width)) : child.render(width),
		);
	}
	/** Header key hints (coding-agent's startup header lists, limited to what p2 binds). */
	private headerHints(expanded: boolean): string[] {
		const hint = (id: string, label: string) => (this.ctx.hints.keyText(id) ? this.ctx.hints.key(id, label) : "");
		const raw = (key: string, label: string) => this.ctx.hints.raw(key, label);
		const list = expanded
			? [
					hint("app.interrupt", "to interrupt"),
					hint("app.clear", "to clear"),
					hint("app.exit", "to exit (empty)"),
					hint("app.thinking.cycle", "to cycle thinking level"),
					hint("app.model.select", "to select model"),
					hint("app.tools.expand", "to expand tools"),
					hint("app.thinking.toggle", "to expand thinking"),
					hint("p2.sessions", "for sessions"),
					hint("app.message.followUp", "to queue follow-up"),
					hint("app.message.dequeue", "to edit queued messages"),
					hint("tui.altScreen.pageUp", "to scroll up"),
					hint("tui.altScreen.search", "to search the transcript"),
					raw("/", "for commands"),
				]
			: [
					hint("app.interrupt", "interrupt"),
					raw(`${this.ctx.hints.keyText("app.clear")}/${this.ctx.hints.keyText("app.exit")}`, "clear/exit"),
					raw("/", "commands"),
					hint("app.tools.expand", "more"),
				];
		return list.filter(Boolean);
	}
	private helpLine(): string {
		const hint = (id: string, label: string) => {
			const keys = this.ctx.hints.keyText(id);
			return keys ? this.ctx.hints.key(id, label) : "";
		};
		return [
			hint("p2.sessions", "sessions"),
			hint("app.model.select", "model"),
			hint("p2.palette", "commands"),
			this.ctx.hints.raw("/hotkeys", "keys"),
			hint("app.exit", "exit"),
		]
			.filter(Boolean)
			.join("  ");
	}
	dispose(): void {
		this.closeOverlays();
		this.closePanel();
		this.stopCommands?.();
		this.stopRegistry?.();
		for (const surface of this.surfaces.values()) surface.dispose();
		this.surfaces.clear();
	}
}
