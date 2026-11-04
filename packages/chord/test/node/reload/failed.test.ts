// Reload suite, row "a plugin whose new build or evaluation fails" (design §21 "What a user sees during a reload"):
// everything stays on screen; the plugin keeps its old code and the error is reported to the app; calls and state are
// unaffected. Through a real page: a worker plugin whose new code fails to build, throws when evaluated, or whose setup
// throws (staging), and a web plugin whose new code fails to build or throws when evaluated.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { editAndApply, ok, ReloadPage, rolloutFailures, rolloutFates, startReloadApp } from "../fixtures/reload/app.ts";
import { counterPlugin, LATCH_PLUGIN, webPlugin } from "../fixtures/reload/plugins.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";

/** The counter as the web plugins show it. */
const COUNTER = { placement: "worker", contract: "v1" } as const;

describe.skipIf(CHROMIUM === undefined)("a reload whose new code fails", () => {
	let browser: Browser;
	let page: ReloadPage;

	beforeAll(async () => {
		browser = await Browser.start();
		page = new ReloadPage(browser);
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it.each(["build", "evaluation", "setup"] as const)(
		"keeps a worker plugin whose new %s fails on its old code, the page untouched",
		async (broken) => {
			const placement = "worker";
			const app = await startReloadApp({
				latch: LATCH_PLUGIN,
				counter: counterPlugin({ code: "v1", placement }),
				alpha: webPlugin({ name: "alpha", code: "1", counter: { placement, contract: "v1" } }),
			});
			try {
				await page.signIn(app, ["alpha"]);
				expect(await page.result(await page.call("alpha", "add", 2))).toEqual(ok("v1:2"));
				await page.waitText("alpha", ".label", "v1:2");
				await page.type("alpha", ".draft", "half-typed");
				const settled = (await page.states("alpha")).length;
				const frames = (await page.frames("alpha")).length;

				const result = await editAndApply(app, "counter", counterPlugin({ code: "v2", placement, broken }));
				// Reported to the app: the worker kept the plugin's old code, and it stays dirty for the next apply.
				expect(rolloutFailures(result)).toEqual(["project/project|p1: @test/counter"]);
				expect(app.app.plugins.state.value.dirty).toContain("@test/counter");

				// The page: nothing moved, calls answered by the old code, the document as it was.
				expect(await page.result(await page.call("alpha", "code"))).toEqual(ok("v1"));
				expect(await page.result(await page.call("alpha", "add", 1))).toEqual(ok("v1:3"));
				await page.waitText("alpha", ".label", "v1:3");
				expect((await page.states("alpha")).slice(settled)).toEqual([]);
				expect((await page.frames("alpha")).slice(frames)).toEqual(["v1:3"]);
				expect(await page.result(await page.call("alpha", "visits"))).toEqual(ok(2));
				expect(await page.value("alpha", ".draft")).toBe("half-typed");
				expect(await page.loads()).toBe(1);
			} finally {
				await app.app.close(context);
			}
		},
		120_000,
	);

	/** The app with the counter, a web plugin `alpha` showing it and a web plugin `beta`, alpha's inputs typed in. */
	async function webApp() {
		const app = await startReloadApp({
			latch: LATCH_PLUGIN,
			counter: counterPlugin({ code: "v1", placement: "worker" }),
			alpha: webPlugin({ name: "alpha", code: "1", counter: COUNTER }),
			beta: webPlugin({ name: "beta", code: "1" }),
		});
		await page.signIn(app, ["alpha", "beta"]);
		await page.waitText("alpha", ".label", "v1:0");
		await page.type("alpha", ".draft", "half-typed");
		await page.type("alpha", ".kept", "kept");
		return app;
	}

	/** The old component still mounted with its state, its reference untouched since `settled` states, calls answered. */
	async function oldComponentKept(settled: number): Promise<void> {
		expect(await page.text("alpha", ".code")).toBe("alpha:1");
		expect(await page.value("alpha", ".draft")).toBe("half-typed");
		expect(await page.value("alpha", ".kept")).toBe("kept");
		expect((await page.states("alpha")).slice(settled)).toEqual([]);
		expect(await page.result(await page.call("alpha", "add", 1))).toEqual(ok("v1:1"));
		expect(await page.loads()).toBe(1);
	}

	it("keeps a web plugin whose new build fails on its old code, its component and state on screen", async () => {
		const app = await webApp();
		try {
			const settled = (await page.states("alpha")).length;
			const result = await editAndApply(
				app,
				"alpha",
				webPlugin({ name: "alpha", code: "2", counter: COUNTER, broken: "build" }),
			);
			// Reported to the app: the web step kept the plugin's old script, and it stays dirty for the next apply.
			expect(rolloutFailures(result)).toEqual(["web/web: @test/alpha"]);
			expect(app.app.plugins.state.value.dirty).toContain("@test/alpha");
			await new Promise((resolve) => setTimeout(resolve, 500));
			await oldComponentKept(settled);
			expect(await browser.evaluate("globalThis.page.errors")).toEqual([]);
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	// Open design point (2026-11-04, with the owner): pages don't report kept-old plugins back. The server's web step
	// publishes the set without waiting for clients, so it marks the plugin applied (no longer dirty) although the page
	// kept its old code; decision "Per plugin at startup and reload" (5) says a plugin kept old on any host stays dirty.
	it("keeps a web plugin whose new script throws in the page on its old code, reported in the page; the server marks it applied (open: pages don't report kept-old plugins back)", async () => {
		const app = await webApp();
		try {
			const settled = (await page.states("alpha")).length;
			await editAndApply(
				app,
				"alpha",
				webPlugin({ name: "alpha", code: "2", counter: COUNTER, broken: "evaluation" }),
			);
			// The page evaluates the script: it keeps the old one and reports it (`startPage`'s `onError`).
			await browser.wait("globalThis.page.errors.length > 0");
			expect(await browser.evaluate("globalThis.page.errors")).toEqual([
				{ kind: "plugins", plugins: ["@test/alpha"] },
			]);
			await oldComponentKept(settled);
			// Today's behaviour, the open point above: the server considers it applied.
			expect(app.app.plugins.state.value.dirty).toEqual([]);
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	// A case the table leaves out (the audit's "new code that fails at activation"): the new code passes staging, so the
	// commit applies it; its native then fails to open. A runtime state (§21: failed opens stay per object after the
	// commit): the old code is gone, the page shows the failure with the last values, and the next fix applies.
	it("shows a failure with the last values when new code passes staging and fails at activation, until a fix", async () => {
		const placement = "worker";
		const app = await startReloadApp({
			latch: LATCH_PLUGIN,
			counter: counterPlugin({ code: "v1", placement, native: true }),
			alpha: webPlugin({ name: "alpha", code: "1", counter: COUNTER }),
		});
		try {
			await page.signIn(app, ["alpha"]);
			expect(await page.result(await page.call("alpha", "add", 2))).toEqual(ok("v1:2"));
			await page.waitText("alpha", ".label", "v1:2");
			const result = await editAndApply(
				app,
				"counter",
				counterPlugin({ code: "v2", placement, native: true, broken: "open" }),
			);
			expect(rolloutFailures(result)).toEqual([]);
			expect(rolloutFates(result)).toContain("project/project|p1: reload.counter(p1) restarted");
			expect(app.app.plugins.state.value.dirty).toEqual([]);
			await page.waitText("alpha", ".state", "failed");
			expect(await page.text("alpha", ".label")).toBe("v1:2");
			expect(await page.result(await page.call("alpha", "code"))).toMatchObject({ status: "error" });

			await editAndApply(app, "counter", counterPlugin({ code: "v3", placement, native: true }));
			await page.waitText("alpha", ".state", "live");
			await page.waitText("alpha", ".label", "v3:2");
			expect(await page.result(await page.call("alpha", "code"))).toEqual(ok("v3"));
		} finally {
			await app.app.close(context);
		}
	}, 120_000);
});
