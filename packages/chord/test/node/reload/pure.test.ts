// Reload suite, row "pure code (no natives) on the server or a worker" (design §21 "What a user sees during a reload"):
// the view stays bound, one fresh snapshot once the new code is live, values change only where the new code computes
// differently; a running call finishes on the old code, a call arriving meanwhile waits and runs on the new code, never
// `not_ready`; documents and tables unchanged. Through a real page, for a counter on a project's worker and on the
// server.

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
} from "../fixtures/reload/app.ts";
import { counterPlugin, LATCH_PLUGIN, type Placement, summaryPlugin, webPlugin } from "../fixtures/reload/plugins.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";

describe.skipIf(CHROMIUM === undefined)("a reload of pure code", () => {
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
		it("keeps the view bound, finishes a running call on the old code and runs new calls on the new code", async () => {
			const app = await startReloadApp({
				latch: LATCH_PLUGIN,
				counter: counterPlugin({ code: "v1", placement }),
				alpha: webPlugin({ name: "alpha", code: "1", counter: { placement, contract: "v1" } }),
			});
			try {
				await page.signIn(app, ["alpha"]);
				await page.waitText("alpha", ".label", "v1:0");
				expect(await page.result(await page.call("alpha", "add", 2))).toEqual(ok("v1:2"));
				await page.waitText("alpha", ".label", "v1:2");
				await page.type("alpha", ".draft", "half-typed");
				const settled = (await page.states("alpha")).length;
				const hand = await latches(app, placement);
				const running = await page.call("alpha", "slow", "running");
				await hand.entered("running");

				// The new code computes the label differently (its code name) and the count the same.
				const applying = editAndApply(app, "counter", counterPlugin({ code: "v2", placement }));
				// Calls sent while the rollout runs: each answered by the old or the new code, never `not_ready`.
				const during: number[] = [];
				let applied = false;
				void applying.finally(() => {
					applied = true;
				});
				while (!applied) {
					during.push(await page.call("alpha", "code"));
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				const result = await applying;
				expect(rolloutFailures(result)).toEqual([]);
				const step = placement === "worker" ? "project/project|p1" : "server/server";
				expect(rolloutFates(result)).toEqual([
					`${step}: reload.store swapped`,
					`${step}: reload.counter(p1) swapped`,
				]);

				// Arriving after the commit, while the old call still runs: the new code answers.
				expect(await page.result(await page.call("alpha", "add", 1))).toEqual(ok("v2:3"));
				expect(await page.peek(running)).toEqual({ status: "pending" });
				await hand.open("running");
				expect(await page.result(running)).toEqual(ok("v1:running"));
				for (const index of during) {
					const answer = await page.result(index);
					expect([ok("v1"), ok("v2")]).toContainEqual(answer);
				}

				await page.waitText("alpha", ".label", "v2:3");
				// Bound throughout: the reference never left `live`, its label went from the old value to the new.
				expect((await page.states("alpha")).slice(settled - 1)).toEqual(["live"]);
				const frames = await page.frames("alpha");
				expect(frames.filter((frame) => typeof frame === "string" && frame.startsWith("failed"))).toEqual([]);
				expect(frames.slice(frames.indexOf("v1:2"))).toEqual(["v1:2", "v2:2", "v2:3"]);
				// Documents and tables unchanged: the count went on from 2, the table kept the old code's rows.
				expect(await page.text("alpha", ".count")).toBe("3");
				expect(await page.result(await page.call("alpha", "visits"))).toEqual(ok(2));
				// The page itself was not touched.
				expect(await page.value("alpha", ".draft")).toBe("half-typed");
				expect(await page.loads()).toBe(1);
			} finally {
				await app.app.close(context);
			}
		}, 120_000);
	});

	// The audit's F1: every `self.get` of a type on another host opens a new hold, which starts `loading`, so the new
	// attempt of a pure object over a worker object parks instead of swapping in place.
	// Expected to fail until the open design point is settled: "a parked swap keeps the old instance serving" (under review).
	it.fails(
		"keeps the view of a pure server object over a worker object bound when only the server object reloads",
		async () => {
			const app = await startReloadApp({
				latch: LATCH_PLUGIN,
				counter: counterPlugin({ code: "v1", placement: "worker" }),
				summary: summaryPlugin("s1"),
				alpha: webPlugin({
					name: "alpha",
					code: "1",
					counter: { placement: "server", contract: "v1" },
					summary: true,
				}),
			});
			try {
				await page.signIn(app, ["alpha"]);
				await page.waitText("alpha", ".label", "s1(0)");
				const settled = (await page.states("alpha")).length;
				const result = await editAndApply(app, "summary", summaryPlugin("s2"));
				expect(rolloutFailures(result)).toEqual([]);
				await page.waitText("alpha", ".label", "s2(0)");
				expect(await page.result(await page.call("alpha", "code"))).toEqual(ok("s2"));
				expect((await page.states("alpha")).slice(settled)).toEqual([]);
				expect(rolloutFates(result)).toEqual(["server/server: reload.summary(p1) swapped"]);
			} finally {
				await app.app.close(context);
			}
		},
		120_000,
	);
});
