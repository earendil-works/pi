import {
	createContext,
	type MouseEvent,
	type RefObject,
	useContext,
	useLayoutEffect,
	useSyncExternalStore,
} from "react";
import { panelsFor, rememberPanels } from "./session-panels.ts";
// Adapted from Pi Mobile: independent browser-only navigation, no app imports.
// Plugins own named modal locators; the runtime owns the stack and Back behavior.
export type Layer = { kind: "drawer" } | { kind: "sheet" | "viewer"; name: string; locator?: string };
export type WorkspaceTab = "files" | "changes" | "search" | "comments" | "terminal";
export type WorkspaceFileRoute = { path: string; view: "changes" | "file" | "preview"; line?: number; commit?: string };
export type WorkspaceRoute = {
	tab: WorkspaceTab;
	directory: string;
	file?: WorkspaceFileRoute;
	commit?: string;
	search?: { text: string; include?: string; exclude?: string };
	terminal?: string;
	startTerminal?: boolean;
};
export type WorkspaceLocation = WorkspaceRoute;
/**
 * Where the app is. Without `session`, `page` and `newSession` it is home (`/`): what a plugin's `home` slot shows (the
 * Familiar's session), else the new-session screen.
 */
export type Route = {
	session?: string;
	/**
	 * A sidebar rollup's or group's list in the main area instead of a conversation (the owner's), by its key
	 * (plugins/sessions/sidebar/model.ts). Never together with `session`.
	 */
	page?: string;
	/** The new-session screen (`/new`). Never together with `session` or `page`. */
	newSession?: true;
	conversation: number;
	layers: Layer[];
	workspace?: WorkspaceLocation;
	/** The transcript block shown in the side panel (SidePanel.tsx); never together with `panel`. */
	activity?: { row: string; step?: string };
	/** A plugin's panel shown in the side panel, by its name; never together with `activity`. */
	panel?: string;
	terminal?: string;
	startTerminal?: boolean;
};

export const HOME: Route = { conversation: 1, layers: [] };

/** The new-session screen. */
export const NEW_SESSION: Route = { newSession: true, conversation: 1, layers: [] };

/**
 * Another conversation, with no modal layers, and with its session's panels (session-panels.ts): within the open
 * session the open ones stay (the workspace on the same tab at the new working tree's root, the same terminal); another
 * session gets the panels it last had on this device, none if it never had any. A terminal never starts on its own.
 */
export function conversationRoute(current: Route, session: string | undefined, conversation = 1): Route {
	return {
		...(session ? { session, ...panelsFor(current, session, conversation) } : {}),
		conversation,
		layers: [],
	};
}

export function routePath(route: Route): string {
	if (route.page !== undefined) return `/list/${encodeURIComponent(route.page)}`;
	if (route.newSession) return "/new";
	if (!route.session) return "/";
	return `/s/${route.session}${route.conversation === 1 ? "" : `/c/${route.conversation}`}`;
}

/**
 * The address a link to `route` carries, so another tab opens it (`pathRoute` reads it back): its path, and its top
 * layer when that is a viewer (`?viewer=<name>&at=<locator>`). Viewers only show content, so a link may open one; the
 * address bar keeps showing `routePath` (URLs identify conversations).
 */
export function routeHref(route: Route): string {
	const top = route.layers.at(-1);
	if (top?.kind !== "viewer") return routePath(route);
	const query = new URLSearchParams({ viewer: top.name, ...(top.locator === undefined ? {} : { at: top.locator }) });
	return `${routePath(route)}?${query}`;
}

/**
 * The Radius shell's URL of this brain's start page, once the shell framing this page said it (`shell-bridge.ts`), so
 * links that open in another tab open the shell around the app, not this frame's origin; undefined otherwise (not
 * framed, an older shell, before the shell answered).
 */
let linkBase: string | undefined;
const linkBaseListeners = new Set<() => void>();

/** Sets the base of link addresses (`linkHref`); only the shell bridge calls it. */
export function setLinkBase(base: string | undefined): void {
	if (base === linkBase) return;
	linkBase = base;
	for (const listener of linkBaseListeners) listener();
}

const subscribeLinkBase = (listener: () => void) => {
	linkBaseListeners.add(listener);
	return () => {
		linkBaseListeners.delete(listener);
	};
};

/**
 * The address an in-app link to `route` carries, for a modified or middle click, "Open in new tab" and "Copy link
 * address" (a plain click acts in the page, `inPage`): `routeHref`, under the Radius shell's URL when the app runs in
 * its frame (`/pi/<organization>/<brain>/s/<id>…`, the shell's start page itself without a trailing `/`).
 */
export function linkHref(route: Route): string {
	const href = routeHref(route);
	if (linkBase === undefined) return href;
	if (href === "/") return linkBase;
	return href.startsWith("/?") ? `${linkBase}${href.slice(1)}` : `${linkBase}${href}`;
}

/** `linkHref` for a component, which renders again once the shell's base arrives. */
export function useLinkHref(): (route: Route) => string {
	useSyncExternalStore(
		subscribeLinkBase,
		() => linkBase,
		() => linkBase,
	);
	return linkHref;
}

/**
 * The route a URL alone describes, for entries this module didn't create and pages loaded from a link (`search`: the
 * URL's query, which may name a viewer as `routeHref` writes it).
 */
export function pathRoute(path: string, search = ""): Route {
	const route = basePathRoute(path);
	const query = new URLSearchParams(search);
	const name = query.get("viewer");
	if (!name) return route;
	const locator = query.get("at");
	return { ...route, layers: [{ kind: "viewer", name, ...(locator === null ? {} : { locator }) }] };
}

/** The route of a URL's path alone. */
function basePathRoute(path: string): Route {
	if (path === "/new") return NEW_SESSION;
	const page = /^\/list\/([^/]+)$/.exec(path)?.[1];
	if (page !== undefined)
		try {
			return { ...HOME, page: decodeURIComponent(page) };
		} catch {
			return HOME;
		}
	const match = /^\/s\/([^/]+)(?:\/c\/([1-9]\d*))?$/.exec(path);
	const conversation = Number(match?.[2] ?? 1);
	return match?.[1] && Number.isSafeInteger(conversation) ? { session: match[1], conversation, layers: [] } : HOME;
}

/**
 * A link's click handler that acts in the page (`act`) on a plain primary click; any other click (a modifier, the
 * middle button, "Open in new tab") is the browser's, so the link's target opens in another tab or window.
 */
export const inPage = (act: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	act();
};

export function sameRoute(a: Route, b: Route): boolean {
	return routeKey(a) === routeKey(b);
}

/** Equal routes (or parts of them) give equal keys. */
export function routeKey(value: unknown): string {
	return JSON.stringify(normalize(value));
}

// Drops undefined fields and fixes key order, so equal routes serialize equally.
function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, normalize(entry)]),
	);
}

/**
 * How far back to go to reach `target` instead of adding an entry: the previous entry if
 * it equals the target, else the nearest equal entry reachable without crossing another
 * conversation. Undefined: no such entry, replace the current one.
 */
export function closeDelta(trail: readonly (Route | undefined)[], index: number, target: Route): number | undefined {
	const current = trail[index];
	if (current && sameRoute(current, target)) return 0;
	for (let at = index - 1; at >= 0; at--) {
		const route = trail[at];
		if (!route) return undefined;
		if (sameRoute(route, target)) return at - index;
		if (route.session !== target.session || route.conversation !== target.conversation) return undefined;
	}
	return undefined;
}

/** `doc`: which page load's numbering `index` belongs to; a typed URL starts a new one. */
/**
 * How far back the trailing run of entries matching `inside` reaches, without crossing
 * another conversation: 0 when only the current entry matches.
 */
export function runStart(
	trail: readonly (Route | undefined)[],
	index: number,
	inside: (route: Route) => boolean,
): number {
	const current = trail[index];
	let at = index;
	while (at > 0) {
		const route = trail[at - 1];
		if (
			!route ||
			!inside(route) ||
			route.session !== current?.session ||
			route.conversation !== current?.conversation
		)
			break;
		at--;
	}
	return at - index;
}

// Not in TypeScript's DOM library yet (Chromium 120+; Android Back and Escape fire close).
declare class CloseWatcher {
	onclose: ((event: Event) => void) | null;
	destroy(): void;
}

/** The app's navigation, for components that need the route without props (sheets). */
export const NavigationContext = createContext<Navigation | undefined>(undefined);

/**
 * Keeps a scroll area's position per step: saved while scrolling, restored whenever
 * `key` (the step's route, or the part this area shows) is current again. Content that
 * arrives later, such as a folder listing, is waited for briefly; touching stops that.
 * Without a key the area follows the whole route.
 */
export function useScrollMemory(area: RefObject<HTMLElement | null>, key?: string): void {
	const nav = useContext(NavigationContext);
	const route = useSyncExternalStore(
		nav?.subscribe ?? noSubscription,
		nav?.snapshot ?? noRoute,
		nav?.snapshot ?? noRoute,
	);
	const current = key ?? routeKey(route);
	useLayoutEffect(() => {
		const element = area.current;
		if (!nav || !element) return;
		const target = nav.scroll.get(current) ?? 0;
		const started = performance.now();
		let restoring = true;
		let frame = 0;
		const restore = () => {
			if (!restoring) return;
			if (element.scrollHeight - element.clientHeight >= target || performance.now() - started > 2000) {
				element.scrollTop = target;
				restoring = false;
			} else frame = requestAnimationFrame(restore);
		};
		const stop = () => {
			restoring = false;
			cancelAnimationFrame(frame);
		};
		// Clamping while the content is still short must not overwrite the saved position.
		const save = () => {
			if (!restoring) nav.scroll.set(current, element.scrollTop);
		};
		const touches = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
		restore();
		element.addEventListener("scroll", save, { passive: true });
		for (const type of touches) element.addEventListener(type, stop, { passive: true });
		return () => {
			stop();
			element.removeEventListener("scroll", save);
			for (const type of touches) element.removeEventListener(type, stop);
		};
	}, [nav, area, current]);
}

const noSubscription = () => () => {};
const noRoute = () => HOME;

type Entry = { p2: true; doc: string; index: number; route: Route };
const STORAGE = "p2-navigation";
/** The conversation open when the app was last used, for the next launch (`resumeRoute`). */
const LAST_STORAGE = "p2-last-conversation";
/** A launch within this long of the last use reopens its conversation; after it, the app starts at home. */
const RESUME_WITHIN = 2 * 60 * 60 * 1000;

/** Forgets the conversation to reopen (signing out). */
export function forgetLastConversation(): void {
	try {
		localStorage.removeItem(LAST_STORAGE);
	} catch {}
}

/** Sessions whose main conversation is not 1 (a `/tree` branch), as the catalog last said, for short links. */
const MAINS_STORAGE = "p2-mains";

/** Remembers the main conversations of `rows` that are not 1 (the Sidebar writes them as the catalog changes). */
export function rememberMains(rows: readonly { readonly id: string; readonly main: number }[]): void {
	try {
		localStorage.setItem(
			MAINS_STORAGE,
			JSON.stringify(Object.fromEntries(rows.filter((row) => row.main !== 1).map((row) => [row.id, row.main]))),
		);
	} catch {}
}

/**
 * The main conversation a short link (`/s/<id>`, conversation 1) opens: the session's `/tree` branch as last known
 * on this device, so the page holds that conversation first instead of conversation 1 and a redirect.
 */
export function knownMain(session: string): number {
	try {
		const mains = JSON.parse(localStorage.getItem(MAINS_STORAGE) ?? "{}") as Record<string, unknown>;
		const main = mains[session];
		return typeof main === "number" ? main : 1;
	} catch {
		return 1;
	}
}

/** Whether the page runs as the installed app (a home-screen app), not in a browser tab. */
function installed(): boolean {
	return (
		(navigator as Navigator & { standalone?: boolean }).standalone === true ||
		matchMedia("(display-mode: standalone)").matches
	);
}

/**
 * The conversation to reopen when the installed app launches at `/`: the one open when the app was last used, if that
 * was less than `RESUME_WITHIN` ago. Like a native app, a short break returns to the conversation and a long one
 * starts at home. A browser tab opening `/` (a typed address, the redirect after signing in) starts at home, and a
 * launch with another address (a link) opens that address.
 */
function resumeRoute(): Route | undefined {
	if (!installed()) return undefined;
	try {
		const last = JSON.parse(localStorage.getItem(LAST_STORAGE) ?? "null") as {
			session?: unknown;
			conversation?: unknown;
			at?: unknown;
		} | null;
		if (
			typeof last?.session !== "string" ||
			typeof last.conversation !== "number" ||
			typeof last.at !== "number" ||
			Date.now() - last.at > RESUME_WITHIN
		)
			return undefined;
		return { session: last.session, conversation: last.conversation, layers: [] };
	} catch {
		return undefined;
	}
}

const SCROLL_STORAGE = "p2-navigation-scroll";

function entry(value: unknown): Entry | undefined {
	return value && typeof value === "object" && "p2" in value && "doc" in value && "index" in value && "route" in value
		? (value as Entry)
		: undefined;
}

/**
 * How Back reaches the stack. "watcher": on Android Chromium (browser, installed app)
 * the system Back is a close request: one CloseWatcher takes it while there is a step
 * to undo, without history entries, so Chrome plays no page-back animation. "history":
 * a history entry per step everywhere else. Desktop Back buttons never reach close
 * watchers (only Escape does), the WebView app's native Back calls goBack, and iOS and
 * Firefox have no CloseWatcher.
 */
export type NavigationMode = "watcher" | "history";

export function navigationMode(): NavigationMode {
	const agent = navigator.userAgent;
	return typeof CloseWatcher === "function" && /\bAndroid\b/.test(agent) && !/; wv\)/.test(agent)
		? "watcher"
		: "history";
}

export class Navigation {
	route: Route;
	readonly mode: NavigationMode;
	/** Scroll positions by area and step (useScrollMemory); kept across reloads. */
	readonly scroll: Map<string, number>;
	/** Routes of this tab's steps by index; survives reloads through sessionStorage. */
	private trail: (Route | undefined)[];
	private index: number;
	private doc: string;
	private readonly listeners = new Set<() => void>();
	/** Operations run one at a time: a step back must land before the next one is added. */
	private queue: Promise<void> = Promise.resolve();
	private arrived?: () => void;
	private watcher?: CloseWatcher;

	constructor(mode = navigationMode()) {
		this.mode = mode;
		history.scrollRestoration = "manual";
		const current = entry(history.state);
		this.doc = current?.doc ?? crypto.randomUUID();
		this.index = current?.index ?? 0;
		// A fresh launch at home (no state of this tab: not a reload, not Back) reopens the last conversation if recent.
		// A page load without state of its own (a link, a typed address, a launch) opens with the session's panels.
		const start =
			current?.route ??
			(location.pathname === "/" ? resumeRoute() : undefined) ??
			pathRoute(location.pathname, location.search);
		this.route =
			current || !start.session ? start : { ...start, ...panelsFor(HOME, start.session, start.conversation) };
		this.trail = [];
		try {
			const saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? "null") as {
				doc?: string;
				trail?: Route[];
			} | null;
			if (current && saved?.doc === current.doc && Array.isArray(saved.trail)) this.trail = saved.trail;
		} catch {}
		let positions: [string, number][] = [];
		try {
			const saved: unknown = JSON.parse(sessionStorage.getItem(SCROLL_STORAGE) ?? "[]");
			if (Array.isArray(saved)) positions = saved as [string, number][];
		} catch {}
		this.scroll = new Map(positions);
		this.write("replace");
		window.addEventListener("popstate", this.popped);
		// Scrolling is frequent: positions are stored once, when the page goes away.
		window.addEventListener("pagehide", this.saveScroll);
		// The last use is when the app goes to the background (or away): the time a launch measures from.
		window.addEventListener("pagehide", this.remember);
		document.addEventListener("visibilitychange", this.remember);
	}

	/** Remembers the open conversation and when it was last in use; at home, nothing (a launch starts at home). */
	private readonly remember = () => {
		try {
			const { session, conversation } = this.route;
			if (session) localStorage.setItem(LAST_STORAGE, JSON.stringify({ session, conversation, at: Date.now() }));
			else localStorage.removeItem(LAST_STORAGE);
		} catch {}
	};

	private readonly saveScroll = () => {
		try {
			sessionStorage.setItem(SCROLL_STORAGE, JSON.stringify([...this.scroll].slice(-200)));
		} catch {}
	};

	/** Release browser listeners when the shell unmounts. */
	dispose(): void {
		this.saveScroll();
		window.removeEventListener("pagehide", this.saveScroll);
		window.removeEventListener("pagehide", this.remember);
		document.removeEventListener("visibilitychange", this.remember);
		window.removeEventListener("popstate", this.popped);
		this.watcher?.destroy();
	}

	readonly snapshot = () => this.route;
	readonly subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** A new step: Back returns to the current screen. Identical routes add nothing. */
	push(route: Route): Promise<void> {
		return this.run(() => this.add(route));
	}

	/** The same screen in another state (tabs, view switches, submitted search). */
	replace(route: Route, expected?: Route): Promise<void> {
		return this.run(() => {
			// Server state may arrive while a user navigation is queued. Never replace its destination.
			if (expected && !sameRoute(this.route, expected)) return;
			this.route = route;
			this.write("replace");
		});
	}

	/** Undo the last step, as the system Back does. */
	back(): Promise<void> {
		return this.run(() => this.go(-1));
	}

	/**
	 * Close or go up to `target` (×, ‹, completing a sheet): steps back when that returns
	 * to it, otherwise replaces the current step, so Back never reopens what was closed.
	 */
	close(target: Route | ((route: Route) => Route)): Promise<void> {
		return this.run(async () => {
			const next = typeof target === "function" ? target(this.route) : target;
			const delta = closeDelta(this.trail, this.index, next);
			if (delta !== undefined) await this.go(delta);
			if (!sameRoute(this.route, next)) {
				this.route = next;
				this.write("replace");
			}
		});
	}

	/**
	 * Back to the first step of the trailing run where `inside` holds, replaced by `next`:
	 * switching workspace tabs drops the folders and files visited on the previous tab.
	 */
	reset(inside: (route: Route) => boolean, next: (route: Route) => Route): Promise<void> {
		return this.run(async () => {
			await this.go(runStart(this.trail, this.index, inside));
			this.route = next(this.route);
			this.write("replace");
		});
	}

	/** A parent destination (a subagent's session): Back when it is the previous step, else a new step. */
	backOrPush(target: Route): Promise<void> {
		return this.run(async () => {
			const previous = this.trail[this.index - 1];
			if (previous && sameRoute(previous, target)) await this.go(-1);
			else this.add(target);
		});
	}

	/**
	 * Somewhere else from a modal layer (a drawer pick): the first modal step becomes the
	 * destination, so Back skips the closed layers; choosing what was open only closes.
	 * Never a step back followed by a new history entry: Chrome lets Back skip entries
	 * added without a user gesture since the previous one.
	 */
	closeThenPush(next: (route: Route) => Route): Promise<void> {
		return this.run(async () => {
			const target = next({ ...this.route, layers: [] });
			if (!this.route.layers.length) return this.add(target);
			const start = runStart(this.trail, this.index, (route) => route.layers.length > 0);
			const before = this.trail[this.index + start - 1];
			if (before && sameRoute(before, target)) return this.go(start - 1);
			await this.go(start);
			this.route = target;
			this.write("replace");
		});
	}

	private add(route: Route): void {
		if (sameRoute(route, this.route)) return;
		this.index++;
		this.trail.length = this.index;
		this.route = route;
		this.write("push");
	}

	private run(operation: () => void | Promise<void>): Promise<void> {
		this.queue = this.queue.then(operation).catch(() => {});
		return this.queue;
	}

	private go(delta: number): Promise<void> {
		if (!delta) return Promise.resolve();
		if (this.mode === "watcher") {
			const index = Math.max(0, this.index + delta);
			const route = this.trail[index];
			if (route) {
				this.index = index;
				this.route = route;
				this.write("replace");
			}
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const timer = setTimeout(done, 1000);
			function done() {
				clearTimeout(timer);
				resolve();
			}
			this.arrived = done;
			history.go(delta);
		});
	}

	private readonly popped = (event: PopStateEvent) => {
		const current = entry(event.state);
		if (current) {
			// Another page load numbered that entry: earlier routes are unknown again.
			if (current.doc !== this.doc) {
				this.doc = current.doc;
				this.trail = [];
			}
			this.index = current.index;
			this.route = current.route;
			this.trail[this.index] = this.route;
			rememberPanels(this.route);
		} else {
			// An entry from before this module (or another document): derive it from the URL.
			this.index = Math.max(0, this.index - 1);
			this.route = pathRoute(location.pathname, location.search);
			this.write("replace");
		}
		this.save();
		this.arm();
		const arrived = this.arrived;
		this.arrived = undefined;
		arrived?.();
		for (const listener of this.listeners) listener();
	};

	private write(mode: "push" | "replace"): void {
		this.trail[this.index] = this.route;
		rememberPanels(this.route);
		const state: Entry = { p2: true, doc: this.doc, index: this.index, route: this.route };
		if (mode === "push" && this.mode === "history") history.pushState(state, "", routePath(this.route));
		else history.replaceState(state, "", routePath(this.route));
		this.save();
		this.remember();
		this.arm();
		for (const listener of this.listeners) listener();
	}

	// Watcher mode: exactly one CloseWatcher while there is a step to undo. Re-armed after
	// each Back, it stays separately closable without a user gesture in between.
	private arm(): void {
		if (this.mode !== "watcher" || this.index > 0 === Boolean(this.watcher)) return;
		if (this.watcher) {
			this.watcher.destroy();
			this.watcher = undefined;
			return;
		}
		const watcher = new CloseWatcher();
		watcher.onclose = () => {
			if (this.watcher === watcher) this.watcher = undefined;
			void this.back();
		};
		this.watcher = watcher;
	}

	private save(): void {
		try {
			sessionStorage.setItem(STORAGE, JSON.stringify({ doc: this.doc, trail: this.trail }));
		} catch {}
	}
}
