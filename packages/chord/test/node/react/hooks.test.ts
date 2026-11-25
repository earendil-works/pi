// Tests of the React bindings (slice 11 §3) in a real browser (Chromium; skipped without one), on the fixture's page:
// `useHold` holds while mounted and releases on unmount, `useWatch` re-renders on change, `useRefState` follows the
// reference's state, `useRegistry` the registry (the panels), `usePageState` keeps a value across a remount by another
// component function and starts a new key fresh, `useMessages` re-renders in a language chosen while the page runs,
// half-typed inputs kept, `useEvents` calls the latest listener (also between a commit and its passive effects),
// follows a member change and stops at unmount, `useLive` follows a reference's grant while mounted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { LocaleChoice, local, method, str } from "../../../src/index.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";
import { freePort, panelPlugin, signIn, versionedEntry, webApp } from "../web/support.ts";

/** The mode the desk's admission reads, on the server. */
const DeskMode = local("test.desk.mode", { version: 1, params: {}, members: { mode: str(), set: method(str()) } });

/** A server plugin serving the fixture's `Desk`: a reader or an editor by `DeskMode` (`reader` at first), else denied. */
const DESK_PLUGIN: Readonly<Record<string, string>> = {
	"server.ts": [
		'import { allow, defineFacet, deny, grantable, hostKind, local, method, remote, str } from "@test/app/v1";',
		'const DeskMode = local("test.desk.mode", { version: 1, params: {}, members: { mode: str(), set: method(str()) } });',
		'const Desk = remote("test.desk", { version: 1, params: {}, hostAddress: () => hostKind("server")(), state: { text: str() }, methods: { write: grantable(method(str())) } });',
		"export default defineFacet((h) => {",
		"	h.serve(DeskMode, (_params, self) => {",
		'		const mode = self.writable("reader");',
		"		return { mode: self.derive([mode], ([value]) => value), set: async (next) => { mode.set(next); return null; } };",
		"	});",
		"	h.serve(Desk, (_params, _principal, _admitted, self) => {",
		'		const text = self.writable("a desk");',
		"		const shown = self.derive([text], ([value]) => value);",
		"		return { text: shown, write: async (next) => { text.set(next); return null; } };",
		"	}, {",
		"		admit: (_params, _principal, self) => self.derive([self.get(DeskMode, {}).mode], ([mode]) =>",
		'			mode === "reader" ? allow({}) : mode === "editor" ? allow({ granted: ["write"] }) : deny("no access")),',
		"	});",
		"});",
	].join("\n"),
};

describe.skipIf(CHROMIUM === undefined)("React bindings", () => {
	let browser: Browser;

	beforeAll(async () => {
		browser = await Browser.start();
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it("hold while mounted, re-render on change, release on unmount", async () => {
		const { app } = await webApp(await versionedEntry("1"), await freePort(), {
			plugins: { notes: panelPlugin("Notes", "#123456") },
		});
		try {
			await signIn(browser, app.ownerLink());
			// useRegistry: the plugin's panel.
			await browser.wait('document.querySelector(".panel")?.textContent === "Notes"');
			// useHold + useRefState: the counter held and live.
			await browser.wait('document.getElementById("count")?.dataset.state === "live"');
			expect(await browser.evaluate<string>('document.getElementById("count").textContent')).toBe("0");
			// useWatch: a change re-renders.
			await browser.evaluate('document.getElementById("count").click()');
			await browser.wait('document.getElementById("count").textContent === "1"');
			// Unmounted: the reference is released.
			await browser.evaluate('document.getElementById("toggle").click()');
			await browser.wait('document.getElementById("count") === null && globalThis.counterState() === "ended"');
			// Mounted again: held again.
			await browser.evaluate('document.getElementById("toggle").click()');
			await browser.wait('document.getElementById("count")?.dataset.state === "live"');
		} finally {
			await app.close(context);
		}
	}, 120_000);

	it("keeps page state across a remount by a new function, a new key starting fresh", async () => {
		const { app } = await webApp(await versionedEntry("1"), await freePort());
		try {
			await signIn(browser, app.ownerLink());
			await browser.evaluate('document.getElementById("note").focus()');
			await browser.type("oat mi");
			await browser.wait('document.getElementById("note").value === "oat mi"');
			await browser.evaluate('void (globalThis.mounted = document.getElementById("note"))');
			// A new component function at the same place: React mounts it anew (a new element), the key keeps the value.
			await browser.evaluate('document.getElementById("remount").click()');
			await browser.wait('document.getElementById("note") !== globalThis.mounted');
			expect(await browser.evaluate<string>('document.getElementById("note").value')).toBe("oat mi");
			// Another key starts at its initial value.
			await browser.evaluate('document.getElementById("remount").click()');
			await browser.wait('document.getElementById("note").dataset.key === "other"');
			expect(await browser.evaluate<string>('document.getElementById("note").value')).toBe("");
			// Back to the first key: still kept.
			await browser.evaluate('document.getElementById("remount").click()');
			await browser.wait('document.getElementById("note").dataset.key === "note"');
			expect(await browser.evaluate<string>('document.getElementById("note").value')).toBe("oat mi");
		} finally {
			await app.close(context);
		}
	}, 120_000);

	it("re-renders messages in a language chosen live, keeping half-typed inputs", async () => {
		const { app } = await webApp(await versionedEntry("1"), await freePort());
		try {
			await signIn(browser, app.ownerLink());
			await browser.wait('document.getElementById("greeting")?.textContent === "Hello, 2 clicks"');
			await browser.evaluate('document.getElementById("draft").focus()');
			await browser.type("oat");
			await browser.evaluate('document.getElementById("note").focus()');
			await browser.type("mi");
			await browser.evaluate('void (globalThis.marked = document.getElementById("draft"))');
			// The owner chooses German: the page's host follows the pick, the greeting re-renders, nothing reloads.
			await app.host.root(async (ctx) => (await ctx.get(LocaleChoice, {})).choose("de", ctx), context, {
				principal: { kind: "owner" },
			});
			await browser.wait('document.getElementById("greeting").textContent === "Hallo, 2 Klicks"');
			expect(await browser.evaluate<string>('document.getElementById("greeting").dataset.locale')).toBe("de");
			expect(await browser.evaluate<string>('document.getElementById("draft").value')).toBe("oat");
			expect(await browser.evaluate<string>('document.getElementById("note").value')).toBe("mi");
			expect(await browser.evaluate<boolean>('document.getElementById("draft") === globalThis.marked')).toBe(true);
		} finally {
			await app.close(context);
		}
	}, 120_000);

	it("calls the latest listener of useEvents, follows its member and stops at unmount", async () => {
		const { app } = await webApp(await versionedEntry("1"), await freePort());
		try {
			await signIn(browser, app.ownerLink());
			await browser.wait('document.getElementById("beats")?.dataset.state === "live"');
			const beats = () => browser.evaluate<string[]>("globalThis.beats");
			await browser.evaluate('globalThis.beat("a", 0)');
			await browser.wait("globalThis.beats.length === 1");
			// A new render's layout effect emits: delivered before its passive effects, to that render's listener. A
			// timer's update is not flushed synchronously, so its passive effects run in a later task.
			await browser.evaluate('void setTimeout(() => globalThis.relabel("second"))');
			await browser.wait("globalThis.beats.length === 2");
			expect(await beats()).toEqual(["first:0", "second:1"]);
			// Another member: the first one's subscription stopped.
			await browser.evaluate("globalThis.switchBeats()");
			await browser.wait('document.getElementById("beats").dataset.member === "b"');
			await browser.evaluate('globalThis.beat("a", 2); globalThis.beat("b", 3)');
			await browser.wait("globalThis.beats.length === 3");
			expect((await beats()).at(-1)).toBe("second:3");
			// Unmounted: nothing more.
			await browser.evaluate("globalThis.toggleBeats()");
			await browser.wait('document.getElementById("beats") === null');
			await browser.evaluate('globalThis.beat("b", 4)');
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(await beats()).toEqual(["first:0", "second:1", "second:3"]);
		} finally {
			await app.close(context);
		}
	}, 120_000);

	it("reads a reference while it is live, following a change of its grant while mounted (useLive)", async () => {
		const { app } = await webApp(await versionedEntry("1"), await freePort(), { plugins: { desk: DESK_PLUGIN } });
		const admit = (mode: string) =>
			app.host.root(async (ctx) => (await ctx.get(DeskMode, {})).set(mode, ctx), context);
		const mode = (name: string) => `document.getElementById("desk")?.dataset.mode === "${name}"`;
		try {
			await signIn(browser, app.ownerLink());
			await browser.evaluate("globalThis.showDesk()");
			await browser.wait(mode("reader"));
			// A reader's reference is no editor's: the click writes nothing.
			await browser.evaluate('document.getElementById("desk").click()');
			// Another allowed value while the component is mounted: the same reference, now granted `write`.
			await admit("editor");
			await browser.wait(mode("editor"));
			expect(await browser.evaluate<string>('document.getElementById("desk").textContent')).toBe("a desk");
			await browser.evaluate('document.getElementById("desk").click()');
			await browser.wait('document.getElementById("desk").textContent === "edited"');
			// Denied: nothing is live. Allowed again as a reader: no `write`.
			await admit("none");
			await browser.wait(mode("none"));
			await admit("reader");
			await browser.wait(mode("reader"));
		} finally {
			await app.close(context);
		}
	}, 120_000);
});
