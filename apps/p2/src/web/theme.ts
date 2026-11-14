// The page's colour theme: light or dark, by a preference the outermost host owns (this page, the Radius shell, p2-mac).
import { shellFrame } from "./shell-bridge.ts";

/*
 * The preference (System / Light / Dark, chosen with the sidebar's switch or the command menu's Theme page) lives in
 * one place: the outermost host. The resolved theme is always written to `<html data-theme>`, which style.css keys
 * off, and `<html data-color-scheme>`, which Elanor's design tokens key off (src/web/elanor.css). The page's inline
 * script (src/hosts/web.ts) sets both before styles load (no flash), by the same rule as `startTheme`'s choice of
 * backend below.
 *
 * - `local`: a bare browser (localhost, the LAN). The page owns the preference: its origin's localStorage `pi-theme`
 *   (absent: system), "system" resolved with its own `matchMedia`, other tabs followed through `storage` events.
 * - `shell`: framed by the Radius shell (shell-bridge.ts), once the shell's `hello` carried its theme. The shell owns
 *   the preference and resolves it: the page applies the shell's `scheme` as given and never consults its own
 *   `matchMedia` (an iframe's `prefers-color-scheme` follows the embedder only in some engines). A pick is sent with
 *   `set-theme`; the shell answers each with exactly one `theme` (its echo), so while picks are unanswered the page
 *   drops `theme` messages and applies the one answering its last pick: two quick picks never flicker back.
 * - `native`: in p2-mac (`window.webkit.messageHandlers.piHost`). The app owns the preference and sets its appearance,
 *   which `prefers-color-scheme` follows, so "system" resolves with `matchMedia`; the bridge answers `theme` and
 *   `set-theme` with the preference, and `pi-host-theme` events report every change. While a `set-theme` is
 *   unanswered the page ignores the events (they may be for an earlier pick) and takes the answer to its last request.
 * - `framed`: framed by the shell before its `hello`. The page shows the scheme the shell hinted in the frame's URL
 *   (`#pi-shell-scheme=light|dark`, which the inline script took and removed: `data-pi-shell-scheme`; WebKit does not
 *   resolve a frame's `prefers-color-scheme` with the embedder's `color-scheme`), else the system's. It neither reads
 *   nor writes its stored value, ignores `storage` events and keeps a pick in memory. A `hello` with a theme sends that
 *   pick as `set-theme` (the user's intent wins; the echo settles it), else takes the shell's preference. A `hello`
 *   without one (an older shell) makes the page `local`: it stores the pick, or without one reads the stored value. No
 *   `hello` at all: it stays as it is.
 *
 * Hosted pages (shell, native) never read the stored value and never write it, so a stale forced value in the frame's
 * origin is ignored, never pushed up. A pick applies at once (optimistic); the host's answer replaces it, which
 * settles races between tabs or windows.
 */

export type ThemePreference = "system" | "light" | "dark";

/** A resolved theme. */
export type ThemeScheme = "light" | "dark";

/** The Radius shell's theme as its `hello` and `theme` messages give it. */
export type ShellTheme = { readonly preference: ThemePreference; readonly scheme: ThemeScheme };

/** The theme's side of the shell bridge (shell-bridge.ts calls it). */
export type ShellThemeLink = {
	/** The shell's `hello`: its theme, or undefined from a shell without one; `send` asks the shell for a preference. */
	hello(theme: ShellTheme | undefined, send: (preference: ThemePreference) => void): void;
	/** The shell's `theme` message: its preference changed, or the system scheme under "system". */
	changed(theme: ShellTheme): void;
};

/** p2-mac's message handler in the page world (with reply: `postMessage` resolves to the app's answer). */
type PiHost = { postMessage(message: { type: "theme" } | { type: "set-theme"; preference: ThemePreference }): unknown };

/** Who owns the preference (see above), with what each backend tracks of its host. */
type Backend =
	| { readonly kind: "local" }
	| { readonly kind: "framed"; pick: ThemePreference | undefined; readonly hint: ThemeScheme | undefined }
	| {
			readonly kind: "shell";
			readonly send: (preference: ThemePreference) => void;
			scheme: ThemeScheme;
			/** `set-theme` messages the shell has not answered yet. */
			unanswered: number;
	  }
	| {
			readonly kind: "native";
			readonly host: PiHost;
			/** Bumped by each request and each applied report: an answer counts only when it is the latest. */
			turn: number;
			/** `set-theme` requests without an answer. */
			unanswered: number;
	  };

const KEY = "pi-theme";
// Must match --bg in style.css: the mobile browser bar takes this colour.
const BACKGROUND = { light: "#fbfaf8", dark: "#151413" } as const;
const listeners = new Set<() => void>();
let backend: Backend = { kind: "local" };
let preference: ThemePreference = "system";
let system: MediaQueryList | undefined;

/** Called once from main.tsx, before the first render and before the shell bridge starts; returns a stop function. */
export function startTheme(): () => void {
	if (system) return () => {};
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	system = media;
	const host = nativeHost();
	if (host) backend = { kind: "native", host, turn: 0, unanswered: 0 };
	else if (shellFrame()) backend = { kind: "framed", pick: undefined, hint: shellHint() };
	else preference = read();
	apply();
	const systemChanged = () => {
		if (backend.kind !== "shell") apply();
	};
	// Another tab of this origin changed the theme.
	const stored = (event: StorageEvent) => {
		if (backend.kind !== "local" || (event.key !== KEY && event.key !== null)) return;
		preference = read();
		changed();
	};
	const hostReported = (event: Event) => {
		const reported = themePreference((event as CustomEvent<{ preference?: unknown } | null>).detail?.preference);
		if (backend.kind !== "native" || backend.unanswered > 0 || reported === undefined) return;
		backend.turn++;
		set(reported);
	};
	media.addEventListener("change", systemChanged);
	window.addEventListener("storage", stored);
	if (backend.kind === "native") {
		window.addEventListener("pi-host-theme", hostReported);
		ask(backend, { type: "theme" });
	}
	return () => {
		media.removeEventListener("change", systemChanged);
		window.removeEventListener("storage", stored);
		window.removeEventListener("pi-host-theme", hostReported);
		system = undefined;
		backend = { kind: "local" };
		preference = "system";
	};
}

/** The scheme the shell hinted in the frame's URL, as the page's inline script kept it (src/hosts/web.ts). */
function shellHint(): ThemeScheme | undefined {
	const hint = document.documentElement.dataset.piShellScheme;
	return hint === "light" || hint === "dark" ? hint : undefined;
}

/** p2-mac's bridge, when this page runs in its window. */
function nativeHost(): PiHost | undefined {
	return (window as { webkit?: { messageHandlers?: { piHost?: PiHost } } }).webkit?.messageHandlers?.piHost;
}

function read(): ThemePreference {
	try {
		return themePreference(localStorage.getItem(KEY)) ?? "system";
	} catch {
		return "system";
	}
}

function store(next: ThemePreference): void {
	try {
		if (next === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, next);
	} catch {}
}

/** `value` if it is a preference (stored values and p2-mac's answers and reports are checked with it). */
function themePreference(value: unknown): ThemePreference | undefined {
	return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

/**
 * Asks p2-mac; its answer (`{ preference }`) applies when it answers the latest request and no report came after it.
 * The answers of a backend that was stopped meanwhile go to its own object and change nothing.
 */
function ask(
	native: Extract<Backend, { kind: "native" }>,
	message: { type: "theme" } | { type: "set-theme"; preference: ThemePreference },
): void {
	const turn = ++native.turn;
	const setting = message.type === "set-theme";
	if (setting) native.unanswered++;
	const answered = (answer: unknown) => {
		if (setting) native.unanswered--;
		const given = themePreference((answer as { preference?: unknown } | null)?.preference);
		if (given !== undefined && turn === native.turn && backend === native) set(given);
	};
	Promise.resolve(native.host.postMessage(message)).then(answered, () => answered(undefined));
}

/** Asks the Radius shell for `next`; "system" resolves there, so the current scheme stays until the echo names it. */
function askShell(shell: Extract<Backend, { kind: "shell" }>, next: ThemePreference): void {
	if (next !== "system") shell.scheme = next;
	shell.unanswered++;
	shell.send(next);
}

function apply(): void {
	const resolved = scheme();
	document.documentElement.dataset.theme = resolved;
	document.documentElement.dataset.colorScheme = resolved;
	// The page has one theme-color per system scheme; the resolved theme overrides both.
	for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
		meta.setAttribute("content", BACKGROUND[resolved]);
}

/** The theme to show: the shell's scheme, a forced preference, before `hello` the shell's hint, else the system's. */
function scheme(): ThemeScheme {
	if (backend.kind === "shell") return backend.scheme;
	if (preference !== "system") return preference;
	if (backend.kind === "framed" && backend.hint) return backend.hint;
	return system?.matches ? "dark" : "light";
}

function changed(): void {
	apply();
	for (const listener of listeners) listener();
}

function set(next: ThemePreference): void {
	if (next === preference) apply();
	else {
		preference = next;
		changed();
	}
}

/** The shell bridge's entry: what the Radius shell says about the theme. */
export const shellTheme: ShellThemeLink = {
	hello(theme, send) {
		if (backend.kind === "shell" && theme) {
			// A new `hello` (the shell answered another `ready`): it holds the shell's current theme.
			backend.unanswered = 0;
			shellTheme.changed(theme);
		}
		if (backend.kind !== "framed") return;
		const { pick } = backend;
		if (theme) {
			const shell: Backend = { kind: "shell", send, scheme: theme.scheme, unanswered: 0 };
			backend = shell;
			if (pick === undefined) set(theme.preference);
			else {
				askShell(shell, pick);
				apply();
			}
			return;
		}
		// An older shell: the page owns the preference after all.
		backend = { kind: "local" };
		if (pick === undefined) set(read());
		else store(pick);
	},
	changed(theme) {
		if (backend.kind !== "shell") return;
		// Each pick is answered by one `theme`; until the last pick's comes, the others would flicker back.
		if (backend.unanswered > 0 && --backend.unanswered > 0) return;
		backend.scheme = theme.scheme;
		set(theme.preference);
	},
};

export const getTheme = (): ThemePreference => preference;

export function subscribeTheme(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Picks `next`: stored by this page (local), kept until the shell's `hello` (framed) or asked of the host. */
export function setTheme(next: ThemePreference): void {
	switch (backend.kind) {
		case "local":
			store(next);
			break;
		case "framed":
			backend.pick = next;
			break;
		case "shell":
			askShell(backend, next);
			break;
		case "native":
			ask(backend, { type: "set-theme", preference: next });
			break;
	}
	preference = next;
	changed();
}
