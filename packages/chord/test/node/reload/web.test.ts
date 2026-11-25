// Reload suite, row "a web or terminal plugin" (design §21 "What a user sees during a reload"): the other plugins
// untouched, scroll kept; the reloaded plugin's components remount, their state (`useState`) starts over while page
// state (`usePageState`) survives; the reloaded plugin's calls as above. Through a real page with two web plugins and
// the base bundle's own input.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { editAndApply, latches, ok, ReloadPage, rolloutFailures, startReloadApp } from "../fixtures/reload/app.ts";
import { counterPlugin, LATCH_PLUGIN, webPlugin } from "../fixtures/reload/plugins.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";

/** The counter as the web plugins show it. */
const COUNTER = { placement: "worker", contract: "v1" } as const;

describe.skipIf(CHROMIUM === undefined)("a reload of a web plugin", () => {
	let browser: Browser;
	let page: ReloadPage;

	beforeAll(async () => {
		browser = await Browser.start();
		page = new ReloadPage(browser);
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it("remounts only the reloaded plugin's components, keeping page state, the other plugins and the scroll", async () => {
		const app = await startReloadApp({
			latch: LATCH_PLUGIN,
			counter: counterPlugin({ code: "v1", placement: "worker" }),
			alpha: webPlugin({ name: "alpha", code: "1", counter: COUNTER }),
			beta: webPlugin({ name: "beta", code: "1" }),
		});
		try {
			await page.signIn(app, ["alpha", "beta"]);
			await page.waitText("alpha", ".state", "live");
			expect(await page.result(await page.call("alpha", "add", 2))).toEqual(ok("v1:2"));
			await page.waitText("alpha", ".label", "v1:2");
			await page.type("alpha", ".draft", "alpha draft");
			await page.type("alpha", ".kept", "alpha kept");
			await page.type("beta", ".draft", "beta draft");
			await page.type("beta", ".kept", "beta kept");
			await browser.evaluate('document.getElementById("base-draft").focus()');
			await browser.type("base draft");
			// Marks on the DOM nodes that must survive, and a scroll position.
			await browser.evaluate(
				'document.querySelector("[data-view=beta] .draft").marked = true; document.querySelector("[data-view=alpha] .draft").marked = true; window.scrollTo(0, 1000)',
			);
			expect(await browser.evaluate<number>("window.scrollY")).toBe(1000);

			const result = await editAndApply(app, "alpha", webPlugin({ name: "alpha", code: "2", counter: COUNTER }));
			expect(rolloutFailures(result)).toEqual([]);
			expect(result.steps.map(({ name }) => name)).toEqual(["server", "project", "web"]);

			await page.waitText("alpha", ".code", "alpha:2");
			// The reloaded plugin: a new component (its state starts over), its page state kept, its counter shown again.
			expect(await page.value("alpha", ".draft")).toBe("");
			expect(await browser.evaluate('document.querySelector("[data-view=alpha] .draft").marked ?? false')).toBe(
				false,
			);
			expect(await page.value("alpha", ".kept")).toBe("alpha kept");
			await page.waitText("alpha", ".label", "v1:2");
			await page.waitText("alpha", ".state", "live");
			expect(await page.result(await page.call("alpha", "add", 1))).toEqual(ok("v1:3"));
			// Everything else untouched: the other plugin's component (the same DOM node), the base's input, the scroll.
			expect(await page.text("beta", ".code")).toBe("beta:1");
			expect(await page.value("beta", ".draft")).toBe("beta draft");
			expect(await browser.evaluate('document.querySelector("[data-view=beta] .draft").marked ?? false')).toBe(true);
			expect(await page.value("beta", ".kept")).toBe("beta kept");
			expect(await browser.evaluate<string>('document.getElementById("base-draft").value')).toBe("base draft");
			expect(await browser.evaluate<number>("window.scrollY")).toBe(1000);
			expect(await page.loads()).toBe(1);
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	// Open design point (2026-11-04, with the owner): `useHold` releases the old component's reference when a plugin
	// reload remounts it, and the release aborts its calls in flight on the worker; yet "a component unmounted by a
	// reload has not left" (§21). Asserted as it is today.
	it("ends a call the reloaded plugin's old component made `released`, nothing committed (open: useHold's release on a reload's unmount aborts it)", async () => {
		const app = await startReloadApp({
			latch: LATCH_PLUGIN,
			counter: counterPlugin({ code: "v1", placement: "worker" }),
			alpha: webPlugin({ name: "alpha", code: "1", counter: COUNTER }),
		});
		const hand = await latches(app, "worker");
		try {
			await page.signIn(app, ["alpha"]);
			await page.waitText("alpha", ".state", "live");
			const running = await page.call("alpha", "slowAdd", "running");
			await hand.entered("running");
			await editAndApply(app, "alpha", webPlugin({ name: "alpha", code: "2", counter: COUNTER }));
			await page.waitText("alpha", ".code", "alpha:2");
			await hand.open("running");
			expect(await page.result(running)).toMatchObject({ status: "error", code: "released" });
			// Aborted on the worker: nothing committed.
			await page.waitText("alpha", ".state", "live");
			expect(await page.text("alpha", ".label")).toBe("v1:0");
			expect(await page.result(await page.call("alpha", "visits"))).toEqual(ok(0));
		} finally {
			await hand.open("running");
			await app.app.close(context);
		}
	}, 120_000);

	// A case the table leaves out (the audit's "a plugin whose contributions change shape"): a web plugin's new code
	// contributes no view, then contributes it again; the other plugin's component stays mounted throughout.
	it("removes and restores a view whose plugin's contributions change, the other plugins untouched", async () => {
		const app = await startReloadApp({
			alpha: webPlugin({ name: "alpha", code: "1" }),
			beta: webPlugin({ name: "beta", code: "1" }),
		});
		try {
			await page.signIn(app, ["alpha", "beta"]);
			await page.type("beta", ".draft", "beta draft");
			await page.type("alpha", ".kept", "alpha kept");
			await editAndApply(app, "alpha", webPlugin({ name: "alpha", code: "2", hidden: true }));
			await browser.wait('document.querySelector("[data-view=alpha]") === null');
			expect(await page.value("beta", ".draft")).toBe("beta draft");
			await editAndApply(app, "alpha", webPlugin({ name: "alpha", code: "3" }));
			await page.waitText("alpha", ".code", "alpha:3");
			expect(await page.value("alpha", ".kept")).toBe("alpha kept");
			expect(await page.value("beta", ".draft")).toBe("beta draft");
			expect(await page.loads()).toBe(1);
		} finally {
			await app.app.close(context);
		}
	}, 120_000);
});
