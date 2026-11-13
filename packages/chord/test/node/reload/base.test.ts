// Reload suite, row "base code (the app's client entry, Chord, React)" (design §21 "What a user sees during a
// reload"): the page reloads, the only case losing what is on screen; calls in flight end with the link; page state is
// lost, server state unchanged. The base bundle's entry changes on disk, the watcher flags base code, and the app
// restarts its hosts (the kit's answer to base code) on the same data directory and port.

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { latches, ok, ReloadPage, startReloadApp, versionedMain } from "../fixtures/reload/app.ts";
import { counterPlugin, LATCH_PLUGIN, webPlugin } from "../fixtures/reload/plugins.ts";
import { Browser, CHROMIUM, poll } from "../web/browser.ts";

/** The counter as the web plugins show it. */
const COUNTER = { placement: "worker", contract: "v1" } as const;

describe.skipIf(CHROMIUM === undefined)("a change of base code", () => {
	let browser: Browser;
	let page: ReloadPage;

	beforeAll(async () => {
		browser = await Browser.start();
		page = new ReloadPage(browser);
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it("reloads the page, ends calls in flight with the link, loses page state and keeps server state", async () => {
		const entry = await versionedMain("1");
		const first = await startReloadApp(
			{
				latch: LATCH_PLUGIN,
				counter: counterPlugin({ code: "v1", placement: "worker" }),
				alpha: webPlugin({ name: "alpha", code: "1", counter: COUNTER }),
			},
			{ entry },
		);
		let second: Awaited<ReturnType<typeof startReloadApp>> | undefined;
		try {
			await page.signIn(first, ["alpha"]);
			await page.waitText("alpha", ".state", "live");
			expect(await page.result(await page.call("alpha", "add", 2))).toEqual(ok("v1:2"));
			await page.waitText("alpha", ".label", "v1:2");
			await page.type("alpha", ".kept", "kept");
			await browser.evaluate("globalThis.marked = true");
			const hand = await latches(first, "worker");
			const running = await page.call("alpha", "slowAdd", "running");
			await hand.entered("running");

			// Base code changes; the app restarts its hosts.
			await versionedMain("2", join(entry, ".."));
			await first.app.close(context);
			// The call in flight ends with the link.
			expect(await page.result(running)).toMatchObject({ status: "error" });
			second = await startReloadApp({}, { entry, port: first.port, dataDir: first.dataDir, root: first.root });
			expect(second.app.web!.base).not.toBe(first.app.web!.base);

			// The page reloads for the new base bundle: what was on screen and in page state is gone.
			await browser.wait('globalThis.version === "2" && globalThis.page?.connection === "connected"', 60_000);
			expect(await browser.evaluate("globalThis.marked ?? false")).toBe(false);
			await page.waitText("alpha", ".state", "live");
			expect(await page.value("alpha", ".kept")).toBe("");
			// Server state unchanged: the count as committed before (the cut call never committed).
			expect(await page.text("alpha", ".label")).toBe("v1:2");
			expect(await page.result(await page.call("alpha", "visits"))).toEqual(ok(1));
		} finally {
			await first.app.close(context);
			await second?.app.close(context);
		}
	}, 120_000);

	it("flags a change of the web entry as base code (`plugins.state.base`)", async () => {
		const entry = await versionedMain("1");
		const app = await startReloadApp({ alpha: webPlugin({ name: "alpha", code: "1" }) }, { entry });
		try {
			await versionedMain("2", join(entry, ".."));
			await poll(() => app.app.plugins.state.value.base, 5000, "base code flagged");
		} finally {
			await app.app.close(context);
		}
	}, 60_000);
});
