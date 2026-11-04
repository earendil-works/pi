// Reload suite, the rollout across hosts (design §21 "What a user sees during a reload": "the server, then every
// running worker by the same rules, then the clients' scripts") and the cases the table leaves out: a worker not
// running during the rollout, a page connecting while a restart drains, two rollouts back to back, a rollout while the
// page's link is down. Through real pages.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	edit,
	editAndApply,
	latches,
	ok,
	ReloadPage,
	rolloutFailures,
	rolloutFates,
	startReloadApp,
} from "../fixtures/reload/app.ts";
import { counterPlugin, LATCH_PLUGIN, summaryPlugin, webPlugin } from "../fixtures/reload/plugins.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";

/** The counter as the web plugins show it. */
const COUNTER = { placement: "worker", contract: "v1" } as const;

describe.skipIf(CHROMIUM === undefined)("a rollout across hosts", () => {
	let browser: Browser;
	let page: ReloadPage;

	beforeAll(async () => {
		browser = await Browser.start();
		page = new ReloadPage(browser);
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	/** The app with the counter on the workers and `alpha` showing p1's, signed in, its counter at 2. */
	async function started(native = false) {
		const app = await startReloadApp({
			latch: LATCH_PLUGIN,
			counter: counterPlugin({ code: "v1", placement: "worker", native }),
			alpha: webPlugin({ name: "alpha", code: "1", counter: COUNTER }),
		});
		await page.signIn(app, ["alpha"]);
		await page.waitText("alpha", ".state", "live");
		expect(await page.result(await page.call("alpha", "add", 2))).toEqual(ok("v1:2"));
		await page.waitText("alpha", ".label", "v1:2");
		return app;
	}

	it("reloads the server, then the running workers, then the clients; a worker not running starts on the new code", async () => {
		const app = await started();
		try {
			const result = await editAndApply(app, "counter", counterPlugin({ code: "v2", placement: "worker" }));
			expect(rolloutFailures(result)).toEqual([]);
			expect(result.steps.map(({ name, hosts }) => [name, hosts.map(({ host }) => host)])).toEqual([
				["server", ["server"]],
				["project", ["project|p1"]],
				["web", ["web"]],
			]);
			expect(rolloutFates(result)).toEqual([
				"project/project|p1: reload.store swapped",
				"project/project|p1: reload.counter(p1) swapped",
			]);
			// Project p2 had no worker during the rollout: its first hold starts one on the current set.
			await page.hold("p2", "alpha", 10_000, "p2");
			await page.waitState("p2", "live");
			expect(await page.result(await page.call("p2", "code"))).toEqual(ok("v2"));
			expect(await page.result(await page.call("p2", "add", 1))).toEqual(ok("v2:1"));
			expect(await page.result(await page.call("alpha", "code"))).toEqual(ok("v2"));
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	it("binds a page that connects while a restart drains to the new code once it is live", async () => {
		const app = await started(true);
		const hand = await latches(app, "worker");
		const second = await Browser.start();
		try {
			const running = await page.call("alpha", "slowAdd", "running");
			await hand.entered("running");
			await editAndApply(app, "counter", counterPlugin({ code: "v2", placement: "worker", native: true }));
			// A second page signs in while the old code drains.
			const late = new ReloadPage(second);
			await late.signInAgain(app, ["alpha"]);
			const call = await late.call("alpha", "code");
			await hand.open("running");
			expect(await page.result(running)).toEqual(ok("v2:12"));
			expect(await late.result(call)).toEqual(ok("v2"));
			await late.waitText("alpha", ".label", "v2:12");
			await late.waitText("alpha", ".state", "live");
			await page.waitText("alpha", ".label", "v2:12");
		} finally {
			await hand.open("running");
			await second.close();
			await app.app.close(context);
		}
	}, 120_000);

	it("ends two rollouts back to back on the second's code, the page following without failing", async () => {
		const app = await started();
		try {
			const settled = (await page.states("alpha")).length;
			await edit(app, "counter", counterPlugin({ code: "v2", placement: "worker" }));
			const first = app.app.applyChanges(context);
			await edit(app, "counter", counterPlugin({ code: "v3", placement: "worker" }));
			const second = app.app.applyChanges(context);
			expect(rolloutFailures(await first)).toEqual([]);
			expect(rolloutFailures(await second)).toEqual([]);
			await page.waitText("alpha", ".label", "v3:2");
			expect(await page.result(await page.call("alpha", "add", 1))).toEqual(ok("v3:3"));
			expect((await page.states("alpha")).slice(settled)).toEqual([]);
			expect(app.app.plugins.state.value.dirty).toEqual([]);
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	it("brings a page whose link was down during the rollout onto the new scripts and the new code", async () => {
		const app = await started();
		try {
			await page.type("alpha", ".kept", "kept");
			await browser.evaluate("globalThis.page.holdReconnect(); globalThis.page.dropLink()");
			await browser.wait('globalThis.page.connection !== "connected"');
			await page.waitState("alpha", "loading");
			// The last values stay on screen while the link is down.
			expect(await page.text("alpha", ".label")).toBe("v1:2");

			await edit(app, "counter", counterPlugin({ code: "v2", placement: "worker" }));
			await edit(app, "alpha", webPlugin({ name: "alpha", code: "2", counter: COUNTER }));
			const result = await app.app.applyChanges(context);
			expect(rolloutFailures(result)).toEqual([]);
			await browser.evaluate("globalThis.page.release()");

			await browser.wait('globalThis.page.connection === "connected"');
			await page.waitText("alpha", ".code", "alpha:2");
			await page.waitText("alpha", ".label", "v2:2");
			await page.waitText("alpha", ".state", "live");
			expect(await page.value("alpha", ".kept")).toBe("kept");
			expect(await page.result(await page.call("alpha", "add", 1))).toEqual(ok("v2:3"));
			expect(await page.loads()).toBe(1);
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	// A case the table leaves out (the audit's "a contract change between hosts, consumer first"): the counter's
	// contract moves to v2 without `accepts`, and the server's summary, which holds it, changes with it (it copies the
	// contract file). The server step runs first: the summary's new request meets the old worker serving v1.
	// Expected to fail until the open design point is settled: "a parked swap keeps the old instance serving" (under review).
	it.fails(
		"keeps the view of a server consumer bound while its worker provider moves to a new version with it",
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
				const result = await editAndApply(
					app,
					"counter",
					counterPlugin({ code: "v2", placement: "worker", contract: "v2" }),
				);
				expect(rolloutFailures(result)).toEqual([]);
				await page.waitText("alpha", ".state", "live");
				expect(await page.result(await page.call("alpha", "code"))).toEqual(ok("s1"));
				expect((await page.states("alpha")).slice(settled)).toEqual([]);
			} finally {
				await app.app.close(context);
			}
		},
		120_000,
	);
});
