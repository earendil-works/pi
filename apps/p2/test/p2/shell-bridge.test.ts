// The frame's side of the Radius shell's `pi-shell` channel (src/web/shell-bridge.ts): it reports the app's address to
// the shell that frames it, takes the shell's base for link addresses, passes the shell's theme on and sends the user's
// pick, and does nothing for anyone else. A fake window stands in for the browser: the page itself, its parent (the
// shell) and an unrelated window. theme.test.ts runs the theme module behind it.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HOME, linkHref, type Route } from "../../src/web/navigation.ts";
import { startShellBridge } from "../../src/web/shell-bridge.ts";
import type { ShellTheme, ShellThemeLink, ThemePreference } from "../../src/web/theme.ts";

const SHELL = "https://radius.earendil.com";
const BASE = `${SHELL}/pi/acme/11111111-0000-4000-8000-000000000000`;
const SESSION = "0b0e6f1c-1d2e-4f00-9a7a-3c1e2f1a0b0c";

type Posted = { message: Record<string, unknown>; origin: string };

/** A navigation with `route`, whose `go` notifies subscribers as `Navigation.write` does. */
function fakeNavigation(route: Route = HOME) {
	const listeners = new Set<() => void>();
	return {
		route,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		go(next: Route) {
			this.route = next;
			for (const listener of listeners) listener();
		},
	};
}

/** Installs a page framed by `parent`, the server naming `meta` as its shell; returns what it posted and a sender. */
function framedPage(options: { meta?: string; framed?: boolean } = {}) {
	const posted: Posted[] = [];
	const listeners = new Set<(event: MessageEvent) => void>();
	const parent = {
		postMessage: (message: Record<string, unknown>, origin: string) => posted.push({ message, origin }),
	};
	const self = {
		addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
		removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
	} as Record<string, unknown>;
	self.parent = options.framed === false ? self : parent;
	Object.assign(globalThis, {
		window: self,
		document: {
			querySelector: (selector: string) =>
				selector === 'meta[name="p2-shell-origin"]' && options.meta !== undefined
					? { content: options.meta }
					: null,
		},
	});
	const send = (data: unknown, origin = SHELL, source: unknown = parent) => {
		for (const listener of listeners) listener({ data, origin, source } as MessageEvent);
	};
	return { posted, send, listeners };
}

/** A theme side that records what the bridge passes on; `send` is the last `hello`'s. */
function fakeTheme() {
	const calls: ({ hello: ShellTheme | undefined } | { changed: ShellTheme })[] = [];
	let send: ((preference: ThemePreference) => void) | undefined;
	const link: ShellThemeLink = {
		hello(theme, sender) {
			calls.push({ hello: theme });
			send = sender;
		},
		changed: (theme) => calls.push({ changed: theme }),
	};
	return { link, calls, send: (preference: ThemePreference) => send?.(preference) };
}

const hello = (base: string, extra: Record<string, unknown> = {}) => ({
	channel: "pi-shell",
	type: "hello",
	version: 1,
	base,
	...extra,
});
const themeMessage = (preference: unknown, scheme: unknown) => ({
	channel: "pi-shell",
	type: "theme",
	version: 1,
	preference,
	scheme,
});
const messages = (posted: Posted[]) => posted.map(({ message }) => message);

describe("shell bridge", () => {
	let stop: (() => void) | undefined;
	beforeEach(() => {
		stop = undefined;
	});
	afterEach(() => {
		stop?.();
		Reflect.deleteProperty(globalThis, "window");
		Reflect.deleteProperty(globalThis, "document");
	});

	it("announces itself to the shell's origin only and reports each new address", () => {
		const page = framedPage({ meta: SHELL });
		const navigation = fakeNavigation({ session: SESSION, conversation: 1, layers: [] });
		stop = startShellBridge(navigation, fakeTheme().link);
		navigation.go({ session: SESSION, conversation: 2, layers: [] });
		// A change that keeps the address (a sheet, a panel) reports nothing.
		navigation.go({ session: SESSION, conversation: 2, layers: [{ kind: "sheet", name: "settings" }] });
		navigation.go({
			session: SESSION,
			conversation: 2,
			layers: [{ kind: "viewer", name: "artifacts", locator: "x" }],
		});
		assert.ok(page.posted.every(({ origin }) => origin === SHELL));
		assert.deepEqual(messages(page.posted), [
			{ channel: "pi-shell", version: 1, type: "ready" },
			{ channel: "pi-shell", version: 1, type: "location", path: `/s/${SESSION}` },
			{ channel: "pi-shell", version: 1, type: "location", path: `/s/${SESSION}/c/2` },
			{ channel: "pi-shell", version: 1, type: "location", path: `/s/${SESSION}/c/2?viewer=artifacts&at=x` },
		]);
	});

	it("puts links under the base the shell names, and reports again for it", () => {
		const page = framedPage({ meta: SHELL });
		stop = startShellBridge(fakeNavigation(), fakeTheme().link);
		const route: Route = { session: SESSION, conversation: 1, layers: [] };
		assert.equal(linkHref(route), `/s/${SESSION}`);
		page.send(hello(BASE));
		assert.equal(linkHref(route), `${BASE}/s/${SESSION}`);
		assert.equal(linkHref(HOME), BASE);
		assert.equal(linkHref({ ...HOME, layers: [{ kind: "viewer", name: "artifacts" }] }), `${BASE}?viewer=artifacts`);
		assert.deepEqual(messages(page.posted).at(-1), { channel: "pi-shell", version: 1, type: "location", path: "/" });
		stop();
		stop = undefined;
		assert.equal(linkHref(route), `/s/${SESSION}`);
	});

	it("takes a base only from the parent, from the shell's origin, on that origin", () => {
		const page = framedPage({ meta: SHELL });
		stop = startShellBridge(fakeNavigation(), fakeTheme().link);
		page.send(hello(BASE), "https://evil.test");
		page.send(hello(BASE), SHELL, {});
		page.send(hello("https://evil.test/pi/acme/x"));
		page.send(hello(`${BASE}?x=1`));
		page.send({ ...hello(BASE), channel: "other" });
		page.send("hello");
		assert.equal(linkHref(HOME), "/");
	});

	it("does nothing without a shell origin from the server, or when nothing frames the page", () => {
		for (const options of [
			{},
			{ meta: "javascript:alert(1)" },
			{ meta: `${SHELL}/pi` },
			{ meta: SHELL, framed: false },
		]) {
			const page = framedPage(options);
			const navigation = fakeNavigation();
			const theme = fakeTheme();
			const end = startShellBridge(navigation, theme.link);
			navigation.go({ session: SESSION, conversation: 1, layers: [] });
			assert.deepEqual(page.posted, [], JSON.stringify(options));
			assert.equal(page.listeners.size, 0);
			theme.send("dark");
			assert.deepEqual(page.posted, []);
			end();
		}
	});

	describe("theme", () => {
		const dark = { preference: "dark", scheme: "dark" } as const;

		it("passes the hello's theme on, or none from an older shell", () => {
			const page = framedPage({ meta: SHELL });
			const theme = fakeTheme();
			stop = startShellBridge(fakeNavigation(), theme.link);
			page.send(hello(BASE, { theme: dark }));
			page.send(hello(BASE));
			// Unknown values count as no theme: the page keeps its own.
			page.send(hello(BASE, { theme: { preference: "blue", scheme: "dark" } }));
			page.send(hello(BASE, { theme: { preference: "system" } }));
			assert.deepEqual(theme.calls, [
				{ hello: dark },
				{ hello: undefined },
				{ hello: undefined },
				{ hello: undefined },
			]);
		});

		it("passes each theme message on and sends the user's pick to the shell's origin", () => {
			const page = framedPage({ meta: SHELL });
			const theme = fakeTheme();
			stop = startShellBridge(fakeNavigation(), theme.link);
			page.send(hello(BASE, { theme: dark }));
			theme.send("light");
			page.send(themeMessage("light", "light"));
			page.send(themeMessage("system", "dark"));
			assert.deepEqual(theme.calls, [
				{ hello: dark },
				{ changed: { preference: "light", scheme: "light" } },
				{ changed: { preference: "system", scheme: "dark" } },
			]);
			assert.deepEqual(page.posted.at(-1), {
				message: { channel: "pi-shell", version: 1, type: "set-theme", preference: "light" },
				origin: SHELL,
			});
		});

		it("takes a theme only from the parent, from the shell's origin, with known values", () => {
			const page = framedPage({ meta: SHELL });
			const theme = fakeTheme();
			stop = startShellBridge(fakeNavigation(), theme.link);
			page.send(hello(BASE, { theme: dark }), "https://evil.test");
			page.send(hello(BASE, { theme: dark }), SHELL, {});
			page.send(themeMessage("dark", "dark"), "https://evil.test");
			page.send(themeMessage("dark", "dark"), SHELL, {});
			page.send({ ...themeMessage("dark", "dark"), channel: "other" });
			page.send(themeMessage("dark", "blue"));
			page.send(themeMessage("auto", "dark"));
			page.send(themeMessage(undefined, undefined));
			assert.deepEqual(theme.calls, []);
		});
	});
});
