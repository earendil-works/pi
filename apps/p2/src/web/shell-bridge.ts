import { type Navigation, routeHref, setLinkBase } from "./navigation.ts";
import type { ShellTheme, ShellThemeLink, ThemePreference } from "./theme.ts";

/*
 * The Radius shell's frame
 * ========================
 *
 * Through Radius the app runs in a frame of the Radius shell (`radius.earendil.com/pi/<organization>/<brain>`), on
 * the brain's own origin (`<label>.rdtun.com`). The shell can neither read nor set the frame's address, so on its own
 * its URL stays at the brain's start page while the user moves around in the app: reloading, bookmarking or sharing
 * the shell's URL loses their place, and a link opened in another tab opens the bare frame origin. And the shell's
 * chrome and the app would each keep their own light/dark choice. This bridge is the frame's side of the `pi-shell`
 * channel that fixes these (the shell's side and the full contract: `client/src/views/pi-shell/frame-bridge.ts` in
 * Radius):
 *
 *   app → shell  { channel: "pi-shell", type: "ready", version: 1 }                once per page load
 *   shell → app  { channel: "pi-shell", type: "hello", version: 1, base, theme }   base: the brain's shell URL
 *   app → shell  { channel: "pi-shell", type: "location", version: 1, path }       after every navigation
 *   shell → app  { channel: "pi-shell", type: "theme", version: 1, preference, scheme }   on every change
 *   app → shell  { channel: "pi-shell", type: "set-theme", version: 1, preference }        the user picked one
 *
 * `path` is the route's link address (`routeHref`: its path and, when the top layer is a viewer, that viewer), so the
 * shell's URL reopens what the user sees, also an open artifact. It never is the frame's `location`: a page outside
 * the app's routes, such as a share's join link with its token, never reaches the shell. `base` becomes the base of
 * in-app link addresses (`linkHref`).
 *
 * The theme is the shell's: `theme` is `{ preference, scheme }`, `preference` one of "system", "light", "dark" and
 * `scheme` ("light" or "dark") what the shell resolved it to with its own `matchMedia`. `hello`'s `theme` is the
 * capability: with it the page applies the shell's scheme and shows its preference (theme.ts, backend `shell`), sends
 * the user's pick as `set-theme` and takes the shell's `theme` answer (its echo) as authoritative; the shell also sends
 * `theme` when another of its tabs changes it or the system scheme changes under "system". A `hello` without `theme`
 * (an older shell) leaves the theme to the page (backend `local`). For the first paint before `hello` the shell also
 * puts its resolved scheme into the URL it frames, `#pi-shell-scheme=light|dark` (WebKit does not resolve a frame's
 * `prefers-color-scheme` with the embedder's `color-scheme`): the page's inline script (src/hosts/web.ts) paints it
 * and removes the fragment before the app reads the URL; a colour only, trusted for nothing else.
 *
 * History stays the app's: its `pushState` steps are entries of the tab's history, Back moves this frame, and the
 * shell only ever replaces its URL with the reports, so a step has one entry.
 *
 * Trust: the server writes the shell's origin into the page (`<meta name="p2-shell-origin">`) only for requests the
 * Radius relay verified, the same origin its CSP lets frame the app (`frame-ancestors`). Without it, or when nothing
 * frames the page (localhost, the LAN, the desktop app loading the brain's origin as a window), the bridge does
 * nothing. Messages go to the parent with that origin as `targetOrigin`, never `*`, so a parent of another origin
 * receives nothing; `hello` and `theme` count only from the parent window, from that origin, `hello` with a base on
 * that origin, and a theme only with a known preference and scheme (else the `hello` counts as one without a theme,
 * and `theme` not at all). The worst the shell can do with them is change the app's theme. Older shells ignore the
 * messages and never answer: links then stay this origin's and the theme the page's, as before.
 */

const CHANNEL = "pi-shell";
const VERSION = 1;

/** The Radius shell framing this page, when the server named one (a plain origin) and a parent frames it. */
export function shellFrame(): { readonly origin: string; readonly parent: Window } | undefined {
	const value = document.querySelector<HTMLMetaElement>('meta[name="p2-shell-origin"]')?.content;
	if (!value || window.parent === window) return undefined;
	try {
		return new URL(value).origin === value ? { origin: value, parent: window.parent } : undefined;
	} catch {
		return undefined;
	}
}

/** A message on the channel: an object with its name, else undefined. */
function channelMessage(data: unknown): Record<string, unknown> | undefined {
	if (!data || typeof data !== "object") return undefined;
	const message = data as Record<string, unknown>;
	return message.channel === CHANNEL ? message : undefined;
}

/** The base a `hello` names, if the shell sent one this page may use. */
function helloBase(message: Record<string, unknown>, origin: string): string | undefined {
	if (message.type !== "hello" || typeof message.base !== "string") return undefined;
	try {
		const base = new URL(message.base);
		return base.origin === origin && !base.search && !base.hash ? base.href.replace(/\/$/, "") : undefined;
	} catch {
		return undefined;
	}
}

/** `value`'s preference and scheme, if both are known values. */
function themeIn(value: unknown): ShellTheme | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { preference, scheme } = value as { preference?: unknown; scheme?: unknown };
	if (preference !== "system" && preference !== "light" && preference !== "dark") return undefined;
	if (scheme !== "light" && scheme !== "dark") return undefined;
	return { preference, scheme };
}

/**
 * Speaks the frame's side of the `pi-shell` channel when the Radius shell frames this page, passing what it says about
 * the theme to `theme` (theme.ts `shellTheme`); returns a stop function.
 */
export function startShellBridge(
	navigation: Pick<Navigation, "route" | "subscribe">,
	theme: ShellThemeLink,
): () => void {
	const frame = shellFrame();
	if (!frame) return () => {};
	const { origin, parent } = frame;
	const post = (message: Record<string, unknown>) => {
		try {
			parent.postMessage({ channel: CHANNEL, version: VERSION, ...message }, origin);
		} catch {}
	};
	const setTheme = (preference: ThemePreference) => post({ type: "set-theme", preference });
	let reported: string | undefined;
	const report = () => {
		const path = routeHref(navigation.route);
		if (path === reported) return;
		reported = path;
		post({ type: "location", path });
	};
	const received = (event: MessageEvent) => {
		if (event.source !== parent || event.origin !== origin) return;
		const message = channelMessage(event.data);
		if (!message) return;
		if (message.type === "theme") {
			const changed = themeIn(message);
			if (changed) theme.changed(changed);
			return;
		}
		const base = helloBase(message, origin);
		if (base === undefined) return;
		setLinkBase(base);
		theme.hello(themeIn(message.theme), setTheme);
		// The shell answers each `ready`; it learns where this page is from the next report, so send it again.
		reported = undefined;
		report();
	};
	window.addEventListener("message", received);
	const unsubscribe = navigation.subscribe(report);
	post({ type: "ready" });
	report();
	return () => {
		window.removeEventListener("message", received);
		unsubscribe();
		setLinkBase(undefined);
	};
}
