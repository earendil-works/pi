// Reload suite, row "code holding natives (restart)" (design §21 "What a user sees during a reload", as corrected
// 2026-11-04): while the old code drains its running calls (up to `closeTimeout`) the page stays `live` with its last
// values and whatever the draining old code commits; calls sent meanwhile wait at the gate; then `loading` briefly,
// then a fresh snapshot from the new code, which answers the waiting calls; documents and tables unchanged, natives
// reopened. Through a real page, for a counter holding a native on a project's worker and on the server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	editAndApply,
	latches,
	ok,
	ReloadPage,
	rolloutFailures,
	rolloutFates,
	startReloadApp,
	TIMEOUTS,
} from "../fixtures/reload/app.ts";
import { counterPlugin, LATCH_PLUGIN, type Placement, webPlugin } from "../fixtures/reload/plugins.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";

describe.skipIf(CHROMIUM === undefined)("a reload restarting an object with natives", () => {
	let browser: Browser;
	let page: ReloadPage;

	beforeAll(async () => {
		browser = await Browser.start();
		page = new ReloadPage(browser);
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	describe.each<Placement>(["worker", "server"])("on the %s", (placement) => {
		it("stays live while the old code drains, then shows loading and a fresh snapshot from the new code", async () => {
			const app = await startReloadApp({
				latch: LATCH_PLUGIN,
				counter: counterPlugin({ code: "v1", placement, native: true }),
				alpha: webPlugin({ name: "alpha", code: "1", counter: { placement, contract: "v1" } }),
			});
			const hand = await latches(app, placement);
			try {
				await page.signIn(app, ["alpha"]);
				await page.waitText("alpha", ".state", "live");
				expect(await page.result(await page.call("alpha", "add", 2))).toEqual(ok("v1:2"));
				await page.waitText("alpha", ".label", "v1:2");
				const settled = (await page.states("alpha")).length;
				const before = await hand.natives();
				// A running call that commits once the test lets it go on.
				const running = await page.call("alpha", "slowAdd", "running");
				await hand.entered("running");

				const result = await editAndApply(app, "counter", counterPlugin({ code: "v2", placement, native: true }));
				expect(rolloutFailures(result)).toEqual([]);
				const step = placement === "worker" ? "project/project|p1" : "server/server";
				expect(rolloutFates(result)).toEqual([
					`${step}: reload.store restarted`,
					`${step}: reload.counter(p1) restarted`,
				]);

				// The drain: still `live` with the last values; a call sent now waits at the gate.
				const arriving = await page.call("alpha", "add", 1);
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(await page.peek(arriving)).toEqual({ status: "pending" });
				expect(await page.peek(running)).toEqual({ status: "pending" });
				expect((await page.states("alpha")).slice(settled)).toEqual([]);
				expect(await page.text("alpha", ".state")).toBe("live");
				expect(await page.text("alpha", ".label")).toBe("v1:2");

				// The running call commits through the store (swapped: its new code answers) and finishes on the old
				// counter; the page sees that commit through the old code before `loading`.
				await hand.open("running");
				expect(await page.result(running)).toEqual(ok("v2:12"));
				expect(await page.result(arriving)).toEqual(ok("v2:13"));
				await page.waitText("alpha", ".label", "v2:13");
				await page.waitText("alpha", ".state", "live");
				expect((await page.states("alpha")).slice(settled)).toEqual(["loading", "live"]);
				const frames = await page.frames("alpha");
				const since = frames.slice(frames.lastIndexOf("v1:2"));
				expect(since.slice(0, 2)).toEqual(["v1:2", "v1:12"]);
				expect(since.at(-1)).toBe("v2:13");
				expect(since.filter((frame) => typeof frame === "string" && frame.startsWith("failed"))).toEqual([]);
				// The native closed for the reload and reopened on the new code; documents and tables unchanged.
				const after = await hand.natives();
				expect(after.opens.slice(before.opens.length)).toEqual(["v2"]);
				expect(after.closes.slice(before.closes.length)).toEqual(["v1:reload"]);
				expect(await page.text("alpha", ".count")).toBe("13");
				expect(await page.result(await page.call("alpha", "visits"))).toEqual(ok(3));
			} finally {
				// A failed expectation leaves the call waiting: open it so the close does not wait for the drain.
				await hand.open("running");
				await app.app.close(context);
			}
		}, 120_000);
	});

	it.each<Placement>(["worker", "server"])(
		"cuts a running call off at the reload drain bound on the %s, then runs the waiting call on the new code",
		async (placement) => {
			const app = await startReloadApp({
				latch: LATCH_PLUGIN,
				counter: counterPlugin({ code: "v1", placement, native: true }),
				alpha: webPlugin({ name: "alpha", code: "1", counter: { placement, contract: "v1" } }),
			});
			try {
				await page.signIn(app, ["alpha"]);
				await page.waitText("alpha", ".state", "live");
				const hand = await latches(app, placement);
				const stuck = await page.call("alpha", "slow", "stuck");
				await hand.entered("stuck");
				const started = Date.now();
				await editAndApply(app, "counter", counterPlugin({ code: "v2", placement, native: true }));
				const arriving = await page.call("alpha", "code");
				const cut = await page.result(stuck);
				// The kit passes `reloadDrainTimeout` to the server and the workers: the cut comes before `closeTimeout`.
				expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUTS.reloadDrainTimeout - 100);
				expect(Date.now() - started).toBeLessThan(TIMEOUTS.closeTimeout);
				expect(cut).toMatchObject({ status: "error", code: "released" });
				expect(await page.result(arriving)).toEqual(ok("v2"));
				await page.waitText("alpha", ".state", "live");
			} finally {
				await app.app.close(context);
			}
		},
		120_000,
	);
});
