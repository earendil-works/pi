// Tests of the React bindings (slice 11 §3) in a real browser (Chromium; skipped without one), on the fixture's page:
// `useHold` holds while mounted and releases on unmount, `useWatch` re-renders on change, `useRefState` follows the
// reference's state, `useRegistry` the registry (the panels).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
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
});
