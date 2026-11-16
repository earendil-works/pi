// The page's theme (src/web/theme.ts) with each of its backends: `local` in a bare browser (its own localStorage and
// matchMedia), `shell` when the Radius shell frames the page (through the real shell bridge, src/web/shell-bridge.ts),
// `native` in p2-mac (a fake `window.webkit.messageHandlers.piHost` and `pi-host-theme` events). A fake window and
// document stand in for the browser.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HOME } from "../../src/web/navigation.ts";
import { startShellBridge } from "../../src/web/shell-bridge.ts";
import {
	getTheme,
	setTheme,
	shellTheme,
	startTheme,
	subscribeTheme,
	type ThemePreference,
} from "../../src/web/theme.ts";

const SHELL = "https://radius.earendil.com";
const BASE = `${SHELL}/pi/acme/11111111-0000-4000-8000-000000000000`;

type Message = Record<string, unknown>;
type HostMessage = { type: "theme" } | { type: "set-theme"; preference: ThemePreference };

/** A host's answer the test settles by hand. */
type Pending = { message: HostMessage; answer: (preference: unknown) => void };

/**
 * Installs a browser: `stored` in localStorage, the system's scheme `dark` or not, framed by a shell when `framed` (the
 * server naming it when `meta`), with p2-mac's bridge when `native`, the shell's scheme hint `hint` kept by the inline
 * script. `fades`: view transitions (`"untyped"`: without types, as Safari 18.0; `"skipped"`: the browser skips each,
 * as when the page gets hidden right after its start), whose DOM changes wait for `runFades()`; `hidden` and
 * `reducedMotion` as named.
 */
function browser(options: {
	stored?: string;
	dark?: boolean;
	meta?: boolean;
	framed?: boolean;
	native?: boolean;
	hint?: string;
	fades?: "typed" | "untyped" | "skipped";
	hidden?: boolean;
	reducedMotion?: boolean;
}) {
	const storage = new Map<string, string>(options.stored === undefined ? [] : [["pi-theme", options.stored]]);
	const target = new EventTarget();
	const media = Object.assign(new EventTarget(), { matches: options.dark ?? false });
	const posted: Message[] = [];
	const asked: Pending[] = [];
	const parent = { postMessage: (message: Message, origin: string) => origin === SHELL && posted.push(message) };
	// The shell's scheme hint, as the page's inline script keeps it (src/hosts/web.ts).
	const html = {
		dataset: (options.hint === undefined ? {} : { piShellScheme: options.hint }) as Record<string, string>,
	};
	const metas = [
		{
			content: "",
			setAttribute(_name: string, value: string) {
				this.content = value;
			},
		},
	];
	let frame: (() => void) | undefined;
	const self: Record<string, unknown> = {
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		dispatchEvent: target.dispatchEvent.bind(target),
		matchMedia: (query: string) =>
			query === "(prefers-reduced-motion: reduce)" ? { matches: options.reducedMotion ?? false } : media,
		requestAnimationFrame: (callback: () => void) => {
			frame = callback;
			return 1;
		},
		cancelAnimationFrame: () => {
			frame = undefined;
		},
	};
	/** Each view transition started: its types, and its DOM change until `runFades` runs it. */
	const fades: { types: unknown; update?: () => void }[] = [];
	const transitions =
		options.fades === undefined
			? {}
			: {
					startViewTransition(argument: (() => void) | { update: () => void; types: string[] }) {
						if (typeof argument === "function") fades.push({ types: undefined, update: argument });
						else if (options.fades === "untyped") throw new TypeError("not a function");
						else fades.push({ types: argument.types, update: argument.update });
						const skipped = new DOMException("Skipping view transition", "InvalidStateError");
						return { ready: options.fades === "skipped" ? Promise.reject(skipped) : Promise.resolve() };
					},
				};
	self.parent = options.framed ? parent : self;
	if (options.native)
		self.webkit = {
			messageHandlers: {
				piHost: {
					postMessage: (message: HostMessage) =>
						new Promise((resolve) => asked.push({ message, answer: (preference) => resolve({ preference }) })),
				},
			},
		};
	Object.assign(globalThis, {
		window: self,
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		document: {
			...transitions,
			visibilityState: options.hidden ? "hidden" : "visible",
			documentElement: html,
			querySelector: (selector: string) =>
				selector === 'meta[name="p2-shell-origin"]' && options.meta ? { content: SHELL } : null,
			querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? metas : []),
		},
	});
	/** A message from the shell (the parent, its origin) or from `source` at `origin`. */
	const fromShell = (data: Message, origin = SHELL, source: unknown = parent) =>
		target.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));
	return {
		storage,
		posted,
		asked,
		fromShell,
		fades,
		/** The browser shows the page's first frame. */
		frame: () => frame?.(),
		/** Runs the started fades' DOM changes, in order. */
		runFades() {
			for (const fade of fades) {
				fade.update?.();
				fade.update = undefined;
			}
		},
		/** The resolved theme on `<html>`, checked to agree with Elanor's attribute and the browser bar's colour. */
		shown() {
			assert.equal(html.dataset.colorScheme, html.dataset.theme);
			assert.equal(metas[0]!.content, html.dataset.theme === "dark" ? "#151413" : "#fbfaf8");
			return html.dataset.theme;
		},
		system(dark: boolean) {
			media.matches = dark;
			media.dispatchEvent(new Event("change"));
		},
		/** Another tab of this origin stores `value`. */
		otherTab(value: string | undefined) {
			if (value === undefined) storage.delete("pi-theme");
			else storage.set("pi-theme", value);
			target.dispatchEvent(Object.assign(new Event("storage"), { key: "pi-theme" }));
		},
		hostReports(detail: unknown) {
			target.dispatchEvent(new CustomEvent("pi-host-theme", { detail }));
		},
	};
}

const hello = (theme?: unknown) => ({
	channel: "pi-shell",
	type: "hello",
	version: 1,
	base: BASE,
	...(theme === undefined ? {} : { theme }),
});
const themeMessage = (preference: string, scheme: string) => ({
	channel: "pi-shell",
	type: "theme",
	version: 1,
	preference,
	scheme,
});
const setThemeMessage = (preference: ThemePreference) => ({
	channel: "pi-shell",
	version: 1,
	type: "set-theme",
	preference,
});
const navigation = { route: HOME, subscribe: () => () => {} };
/** Lets the host's answers (promises) settle. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("theme", () => {
	const stops: (() => void)[] = [];
	/** Starts the theme, then the shell bridge, as main.tsx does. */
	const start = () => {
		stops.push(startTheme(), startShellBridge(navigation, shellTheme));
	};
	afterEach(() => {
		for (const stop of stops.splice(0).reverse()) stop();
		for (const name of ["window", "document", "localStorage"]) Reflect.deleteProperty(globalThis, name);
	});

	describe("local", () => {
		it("keeps the preference in this origin's storage, as before", () => {
			const page = browser({ stored: "dark" });
			start();
			assert.equal(getTheme(), "dark");
			assert.equal(page.shown(), "dark");
			setTheme("light");
			assert.equal(page.storage.get("pi-theme"), "light");
			assert.equal(page.shown(), "light");
			setTheme("system");
			assert.equal(page.storage.has("pi-theme"), false);
			page.system(true);
			assert.equal(page.shown(), "dark");
			// Another tab of the origin.
			let notified = 0;
			stops.push(subscribeTheme(() => notified++));
			page.otherTab("light");
			assert.deepEqual([getTheme(), page.shown(), notified], ["light", "light", 1]);
			assert.deepEqual(page.posted, []);
		});

		it("is the backend of a page the server names a shell for that nothing frames", () => {
			const page = browser({ stored: "dark", meta: true });
			start();
			assert.equal(getTheme(), "dark");
			assert.deepEqual(page.posted, []);
		});
	});

	describe("shell", () => {
		it("ignores the frame's own stored value and takes the shell's from its hello", () => {
			const page = browser({ stored: "dark", meta: true, framed: true });
			start();
			// Before the hello: the system's scheme, not the stale forced value.
			assert.deepEqual([getTheme(), page.shown()], ["system", "light"]);
			page.fromShell(hello({ preference: "system", scheme: "light" }));
			assert.deepEqual([getTheme(), page.shown()], ["system", "light"]);
			// The frame's own matchMedia does not count; the shell's theme messages do.
			page.system(true);
			assert.equal(page.shown(), "light");
			page.fromShell(themeMessage("system", "dark"));
			assert.equal(page.shown(), "dark");
			page.fromShell(themeMessage("light", "light"));
			assert.deepEqual([getTheme(), page.shown()], ["light", "light"]);
			// Another tab of the frame's origin storing a value changes nothing either.
			page.otherTab("dark");
			assert.deepEqual([getTheme(), page.shown()], ["light", "light"]);
			assert.equal(page.storage.get("pi-theme"), "dark");
		});

		it("sends a pick, applies it at once, and takes the shell's echo as authoritative", () => {
			const page = browser({ stored: "dark", meta: true, framed: true });
			start();
			page.fromShell(hello({ preference: "light", scheme: "light" }));
			setTheme("dark");
			assert.deepEqual(page.posted.at(-1), setThemeMessage("dark"));
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			// "system" resolves in the shell: the scheme stays until the echo names it.
			setTheme("system");
			assert.deepEqual(page.posted.at(-1), setThemeMessage("system"));
			assert.deepEqual([getTheme(), page.shown()], ["system", "dark"]);
			// The echoes of Dark (dropped: System is unanswered) and of System.
			page.fromShell(themeMessage("dark", "dark"));
			assert.deepEqual([getTheme(), page.shown()], ["system", "dark"]);
			page.fromShell(themeMessage("system", "light"));
			assert.deepEqual([getTheme(), page.shown()], ["system", "light"]);
			// Another shell tab won the race: its value stands.
			setTheme("dark");
			page.fromShell(themeMessage("light", "light"));
			assert.deepEqual([getTheme(), page.shown()], ["light", "light"]);
			// Nothing was stored in the frame's origin.
			assert.equal(page.storage.get("pi-theme"), "dark");
		});

		it("applies only the echo of the last of several quick picks", () => {
			const page = browser({ meta: true, framed: true });
			start();
			page.fromShell(hello({ preference: "system", scheme: "light" }));
			setTheme("light");
			setTheme("dark");
			// The echo of Light: the later Dark stays.
			page.fromShell(themeMessage("light", "light"));
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			page.fromShell(themeMessage("dark", "dark"));
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			// All answered: the shell's next change applies.
			page.fromShell(themeMessage("system", "light"));
			assert.deepEqual([getTheme(), page.shown()], ["system", "light"]);
			// A new hello holds the shell's current theme and forgets unanswered picks.
			setTheme("dark");
			page.fromShell(hello({ preference: "light", scheme: "light" }));
			assert.deepEqual([getTheme(), page.shown()], ["light", "light"]);
			page.fromShell(themeMessage("system", "dark"));
			assert.deepEqual([getTheme(), page.shown()], ["system", "dark"]);
		});

		it("keeps a pick before the hello in memory and sends it once the shell has said its theme", () => {
			const page = browser({ stored: "light", meta: true, framed: true });
			start();
			setTheme("dark");
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			// Neither stored nor followed from the frame's origin.
			assert.equal(page.storage.get("pi-theme"), "light");
			page.otherTab("light");
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			assert.ok(!page.posted.some((message) => message.type === "set-theme"));
			// The user's intent wins over the shell's light; the echo settles it.
			page.fromShell(hello({ preference: "light", scheme: "light" }));
			assert.deepEqual(page.posted.at(-2), setThemeMessage("dark"));
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			page.fromShell(themeMessage("dark", "dark"));
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			assert.equal(page.storage.get("pi-theme"), "light");
		});

		it("shows the scheme the shell hinted until its hello", () => {
			const page = browser({ stored: "light", meta: true, framed: true, hint: "dark" });
			start();
			assert.deepEqual([getTheme(), page.shown()], ["system", "dark"]);
			// The frame's own system scheme does not count before the hello either.
			page.system(true);
			page.system(false);
			assert.equal(page.shown(), "dark");
			// A pick shows at once; System shows the hint again.
			setTheme("light");
			assert.equal(page.shown(), "light");
			setTheme("system");
			assert.equal(page.shown(), "dark");
			page.fromShell(hello({ preference: "light", scheme: "light" }));
			assert.deepEqual(page.posted.at(-2), setThemeMessage("system"));
			page.fromShell(themeMessage("system", "light"));
			assert.deepEqual([getTheme(), page.shown()], ["system", "light"]);
		});

		it("ignores a hint it has no use for: a junk value, or a page the shell does not frame", () => {
			const junk = browser({ meta: true, framed: true, hint: "blue" });
			start();
			assert.equal(junk.shown(), "light");
			for (const stop of stops.splice(0).reverse()) stop();
			const local = browser({ meta: true, hint: "dark" });
			start();
			assert.equal(local.shown(), "light");
		});

		it("follows the system before any hello, its picks kept in memory", () => {
			const page = browser({ stored: "dark", meta: true, framed: true });
			start();
			page.system(true);
			assert.deepEqual([getTheme(), page.shown()], ["system", "dark"]);
			setTheme("light");
			assert.deepEqual([getTheme(), page.shown()], ["light", "light"]);
			assert.equal(page.storage.get("pi-theme"), "dark");
		});

		it("ignores theme messages from another window or origin, or with unknown values", () => {
			const page = browser({ meta: true, framed: true });
			start();
			page.fromShell(hello({ preference: "dark", scheme: "dark" }), "https://evil.test");
			page.fromShell(hello({ preference: "dark", scheme: "dark" }), SHELL, {});
			assert.deepEqual([getTheme(), page.shown()], ["system", "light"]);
			page.fromShell(hello({ preference: "light", scheme: "light" }));
			page.fromShell(themeMessage("dark", "dark"), "https://evil.test");
			page.fromShell(themeMessage("dark", "dark"), SHELL, {});
			page.fromShell(themeMessage("dark", "dusk"));
			page.fromShell(themeMessage("night", "dark"));
			assert.deepEqual([getTheme(), page.shown()], ["light", "light"]);
		});

		it("falls back to the stored value after a hello without a theme (an older shell)", () => {
			const page = browser({ stored: "dark", meta: true, framed: true });
			start();
			// A theme before any hello is not the capability: it does not count.
			page.fromShell(themeMessage("light", "light"));
			assert.equal(page.shown(), "light");
			page.fromShell(hello());
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			setTheme("light");
			assert.equal(page.storage.get("pi-theme"), "light");
			assert.ok(!page.posted.some((message) => message.type === "set-theme"));
			// The page is local now: a later theme message changes nothing.
			page.fromShell(themeMessage("dark", "dark"));
			assert.equal(getTheme(), "light");
		});

		it("stores a pick made before a hello without a theme", () => {
			const page = browser({ stored: "dark", meta: true, framed: true });
			start();
			setTheme("light");
			assert.equal(page.storage.get("pi-theme"), "dark");
			page.fromShell(hello());
			assert.deepEqual([getTheme(), page.shown(), page.storage.get("pi-theme")], ["light", "light", "light"]);
			page.otherTab("dark");
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
		});
	});

	describe("native", () => {
		it("asks p2-mac, never the stored value, and follows its reports", async () => {
			const page = browser({ stored: "dark", native: true });
			start();
			assert.deepEqual([getTheme(), page.shown()], ["system", "light"]);
			assert.deepEqual(
				page.asked.map(({ message }) => message),
				[{ type: "theme" }],
			);
			page.asked[0]!.answer("light");
			await settled();
			assert.deepEqual([getTheme(), page.shown()], ["light", "light"]);
			page.hostReports({ preference: "system" });
			// Under "system" the app's appearance decides, which matchMedia follows.
			page.system(true);
			assert.deepEqual([getTheme(), page.shown()], ["system", "dark"]);
			page.hostReports({ preference: "night" });
			page.hostReports(null);
			assert.equal(getTheme(), "system");
			assert.equal(page.storage.get("pi-theme"), "dark");
		});

		it("sends a pick, applies it at once, and drops the startup answer it overtook", async () => {
			const page = browser({ native: true });
			start();
			page.asked[0]!.answer("system");
			setTheme("dark");
			assert.deepEqual(page.asked[1]!.message, { type: "set-theme", preference: "dark" });
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			await settled();
			assert.equal(getTheme(), "dark");
			page.asked[1]!.answer("dark");
			await settled();
			// Answered: another window's pick applies.
			page.hostReports({ preference: "light" });
			assert.deepEqual([getTheme(), page.shown()], ["light", "light"]);
			setTheme("system");
			page.asked[2]!.answer("dark");
			await settled();
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			assert.equal(page.storage.has("pi-theme"), false);
		});

		it("ignores reports while a pick is unanswered and takes the answer to the last one", async () => {
			const page = browser({ native: true });
			start();
			page.asked[0]!.answer("system");
			await settled();
			setTheme("light");
			setTheme("dark");
			// The report and answer of Light: the later Dark stays.
			page.hostReports({ preference: "light" });
			page.asked[1]!.answer("light");
			await settled();
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			page.hostReports({ preference: "dark" });
			page.asked[2]!.answer("dark");
			await settled();
			assert.deepEqual([getTheme(), page.shown()], ["dark", "dark"]);
			// All answered: reports apply again.
			page.hostReports({ preference: "system" });
			assert.deepEqual([getTheme(), page.shown()], ["system", "light"]);
		});

		it("wins over a shell frame", () => {
			const page = browser({ stored: "dark", native: true, meta: true, framed: true });
			start();
			page.fromShell(hello({ preference: "light", scheme: "light" }));
			setTheme("dark");
			assert.ok(!page.posted.some((message) => message.type === "set-theme"));
			assert.equal(page.asked.at(-1)!.message.type, "set-theme");
		});
	});

	describe("fade", () => {
		const typed = [{ types: ["pi-theme"] }];

		it("fades a pick after the first frame, not what the page shows while it starts", () => {
			const page = browser({ stored: "dark", fades: "typed" });
			start();
			setTheme("light");
			assert.deepEqual([page.fades, page.shown()], [[], "light"]);
			page.frame();
			setTheme("dark");
			// The old state stays until the browser has captured it.
			assert.deepEqual([page.fades.map(({ types }) => ({ types })), page.shown()], [typed, "light"]);
			page.runFades();
			assert.equal(page.shown(), "dark");
		});

		it("fades a change of the shown scheme only", () => {
			const page = browser({ fades: "typed" });
			start();
			page.frame();
			// System (light) → Light: the same scheme.
			setTheme("light");
			setTheme("system");
			assert.equal(page.fades.length, 0);
			page.system(true);
			page.otherTab("light");
			assert.equal(page.fades.length, 2);
			page.runFades();
			assert.equal(page.shown(), "light");
		});

		it("shows the latest scheme when changes overtake a fade", () => {
			const page = browser({ fades: "typed" });
			start();
			page.frame();
			setTheme("dark");
			setTheme("light");
			setTheme("dark");
			assert.equal(page.fades.length, 3);
			page.runFades();
			assert.equal(page.shown(), "dark");
		});

		it("keeps a change shown at once when a fade's DOM change runs after it", () => {
			const page = browser({ meta: true, framed: true, fades: "typed" });
			start();
			page.frame();
			page.system(true);
			assert.equal(page.fades.length, 1);
			page.fromShell(hello({ preference: "light", scheme: "light" }));
			assert.equal(page.shown(), "light");
			page.runFades();
			assert.equal(page.shown(), "light");
		});

		it("does not repaint the scheme a pending fade is about to show", async () => {
			// p2-mac: the answer to a pick and the appearance change it causes come before the fade's DOM change.
			const page = browser({ native: true, fades: "typed" });
			start();
			page.frame();
			setTheme("dark");
			page.asked[1]!.answer("dark");
			await settled();
			page.system(true);
			// The old state is still there for the fade to capture.
			assert.deepEqual([page.fades.length, page.shown()], [1, "light"]);
			page.hostReports({ preference: "dark" });
			assert.equal(page.shown(), "light");
			page.runFades();
			assert.equal(page.shown(), "dark");
		});

		it("does not fade a hidden page, under reduced motion, or without view transitions", () => {
			for (const options of [
				{ fades: "typed", hidden: true },
				{ fades: "typed", reducedMotion: true },
				{},
			] as const) {
				const page = browser(options);
				start();
				page.frame();
				setTheme("dark");
				assert.deepEqual([page.fades, page.shown()], [[], "dark"], JSON.stringify(options));
				for (const stop of stops.splice(0).reverse()) stop();
			}
		});

		it("takes the update function alone where view transitions have no types", () => {
			const page = browser({ fades: "untyped" });
			start();
			page.frame();
			setTheme("dark");
			assert.deepEqual(
				page.fades.map(({ types }) => types),
				[undefined],
			);
			page.runFades();
			assert.equal(page.shown(), "dark");
		});

		it("shows the change of a fade the browser skipped, without an unhandled rejection", async () => {
			const page = browser({ fades: "skipped" });
			const unhandled: unknown[] = [];
			const record = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", record);
			try {
				start();
				page.frame();
				setTheme("dark");
				page.runFades();
				// Node reports an unhandled rejection after the microtasks of the turn that made it.
				await new Promise((resolve) => setImmediate(resolve));
			} finally {
				process.off("unhandledRejection", record);
			}
			assert.deepEqual([unhandled, page.shown()], [[], "dark"]);
		});

		it("does not fade the shell's hint or hello, and fades its later changes", () => {
			const page = browser({ meta: true, framed: true, hint: "dark", fades: "typed" });
			start();
			page.frame();
			page.fromShell(hello({ preference: "light", scheme: "light" }));
			assert.deepEqual([page.fades, page.shown()], [[], "light"]);
			page.fromShell(themeMessage("dark", "dark"));
			setTheme("light");
			page.fromShell(themeMessage("light", "light"));
			assert.equal(page.fades.length, 2);
			page.runFades();
			assert.equal(page.shown(), "light");
		});

		it("does not fade p2-mac's first answer, and fades its reports and a differing answer", async () => {
			const page = browser({ native: true, fades: "typed" });
			start();
			page.frame();
			page.asked[0]!.answer("dark");
			await settled();
			assert.deepEqual([page.fades, page.shown()], [[], "dark"]);
			page.hostReports({ preference: "light" });
			assert.equal(page.fades.length, 1);
			setTheme("dark");
			page.asked[1]!.answer("light");
			await settled();
			assert.equal(page.fades.length, 3);
			page.runFades();
			assert.equal(page.shown(), "light");
		});
	});
});
