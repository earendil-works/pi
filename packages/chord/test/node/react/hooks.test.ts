// Tests of the React bindings (slice 11 §3) in a real browser (Chromium; skipped without one), on the fixture's page:
// `useHold` holds while mounted and releases on unmount, `useWatch` re-renders on change, `useRefState` follows the
// reference's state, `useRegistry` the registry (the panels), `usePageState` keeps a value across a remount by another
// component function and starts a new key fresh, `useMessages` re-renders in a language chosen while the page runs,
// half-typed inputs kept.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { LocaleChoice } from "../../../src/index.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";
import { freePort, panelPlugin, signIn, versionedEntry, webApp } from "../web/support.ts";

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
});
