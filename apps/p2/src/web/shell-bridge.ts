import { type Navigation, routeHref, setLinkBase } from "./navigation.ts";

/*
 * The Radius shell's frame
 * ========================
 *
 * Through Radius the app runs in a frame of the Radius shell (`radius.earendil.com/pi/<organization>/<brain>`), on
 * the brain's own origin (`<label>.rdtun.com`). The shell can neither read nor set the frame's address, so on its own
 * its URL stays at the brain's start page while the user moves around in the app: reloading, bookmarking or sharing
 * the shell's URL loses their place, and a link opened in another tab opens the bare frame origin. This bridge is the
 * frame's side of the `pi-shell` channel that fixes both (the shell's side and the full contract:
 * `client/src/views/pi-shell/frame-bridge.ts` in Radius):
 *
 *   app → shell  { channel: "pi-shell", type: "ready", version: 1 }                once per page load
 *   shell → app  { channel: "pi-shell", type: "hello", version: 1, base }          base: the brain's shell URL
 *   app → shell  { channel: "pi-shell", type: "location", version: 1, path }       after every navigation
 *
 * `path` is the route's link address (`routeHref`: its path and, when the top layer is a viewer, that viewer), so the
 * shell's URL reopens what the user sees, also an open artifact. It never is the frame's `location`: a page outside
 * the app's routes, such as a share's join link with its token, never reaches the shell. `base` becomes the base of
 * in-app link addresses (`linkHref`).
 *
 * History stays the app's: its `pushState` steps are entries of the tab's history, Back moves this frame, and the
 * shell only ever replaces its URL with the reports, so a step has one entry.
 *
 * Trust: the server writes the shell's origin into the page (`<meta name="p2-shell-origin">`) only for requests the
 * Radius relay verified, the same origin its CSP lets frame the app (`frame-ancestors`). Without it, or when nothing
 * frames the page (localhost, the LAN, the desktop app loading the brain's origin as a window), the bridge does
 * nothing. Messages go to the parent with that origin as `targetOrigin`, never `*`, so a parent of another origin
 * receives nothing; `hello` counts only from the parent window, from that origin, with a base on that origin. Older
 * shells ignore the messages and never answer: links then stay this origin's, as before.
 */

const CHANNEL = "pi-shell";
const VERSION = 1;

/** The Radius shell origin the server named for this page, if it is a plain origin. */
function shellOrigin(): string | undefined {
	const value = document.querySelector<HTMLMetaElement>('meta[name="p2-shell-origin"]')?.content;
	if (!value) return undefined;
	try {
		return new URL(value).origin === value ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The base a `hello` names, if the shell sent one this page may use. */
function helloBase(data: unknown, origin: string): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const message = data as { channel?: unknown; type?: unknown; base?: unknown };
	if (message.channel !== CHANNEL || message.type !== "hello" || typeof message.base !== "string") return undefined;
	try {
		const base = new URL(message.base);
		return base.origin === origin && !base.search && !base.hash ? base.href.replace(/\/$/, "") : undefined;
	} catch {
		return undefined;
	}
}

/** Speaks the frame's side of the `pi-shell` channel when the Radius shell frames this page; returns a stop function. */
export function startShellBridge(navigation: Pick<Navigation, "route" | "subscribe">): () => void {
	const origin = shellOrigin();
	const parent = window.parent;
	if (!origin || parent === window) return () => {};
	const post = (message: Record<string, unknown>) => {
		try {
			parent.postMessage({ channel: CHANNEL, version: VERSION, ...message }, origin);
		} catch {}
	};
	let reported: string | undefined;
	const report = () => {
		const path = routeHref(navigation.route);
		if (path === reported) return;
		reported = path;
		post({ type: "location", path });
	};
	const received = (event: MessageEvent) => {
		if (event.source !== parent || event.origin !== origin) return;
		const base = helloBase(event.data, origin);
		if (base === undefined) return;
		setLinkBase(base);
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
