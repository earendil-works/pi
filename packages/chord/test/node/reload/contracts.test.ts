// Reload suite, rows "a contract change the new code still `accepts`" and "a contract change not accepted, or a type
// removed" (design §21 "What a user sees during a reload"). Accepted: the old page keeps working through the mapping,
// its calls answered through it. Not accepted or removed: the reference waits with its last values (`failed
// { waiting }`: `version`, `not_served`) until the page's code updates or the type returns; a call on it fails at once
// with the cause (`contract_mismatch`, `unavailable` not served; as corrected upstream); state unchanged. The page's
// web plugin keeps its own copy of the contract (an old page) while the counter on the worker moves.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	editAndApply,
	ok,
	ReloadPage,
	removeAndApply,
	rolloutFailures,
	startReloadApp,
} from "../fixtures/reload/app.ts";
import { counterPlugin, LATCH_PLUGIN, webPlugin } from "../fixtures/reload/plugins.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";

/** The page's short reference's `readyTimeout`: a call failing at once answers well before it. */
const PARK_MS = 1500;

describe.skipIf(CHROMIUM === undefined)("a reload changing a contract", () => {
	let browser: Browser;
	let page: ReloadPage;

	beforeAll(async () => {
		browser = await Browser.start();
		page = new ReloadPage(browser);
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	/** The app with the counter at v1 on worker `p1`, the page showing it (`alpha`) with a count of 2. */
	async function oldPage() {
		const placement = "worker";
		const app = await startReloadApp({
			latch: LATCH_PLUGIN,
			counter: counterPlugin({ code: "v1", placement }),
			alpha: webPlugin({ name: "alpha", code: "1", counter: { placement, contract: "v1" } }),
		});
		await page.signIn(app, ["alpha"]);
		expect(await page.result(await page.call("alpha", "add", 2))).toEqual(ok("v1:2"));
		await page.waitText("alpha", ".label", "v1:2");
		await page.type("alpha", ".draft", "half-typed");
		return app;
	}

	it("keeps an old page working through the mapping of a contract the new code accepts", async () => {
		const app = await oldPage();
		try {
			const settled = (await page.states("alpha")).length;
			const result = await editAndApply(
				app,
				"counter",
				counterPlugin({ code: "v2", placement: "worker", contract: "v2", accepts: true }),
			);
			expect(rolloutFailures(result)).toEqual([]);
			// The v1 page reads v2's label mapped back, and its v1 call is mapped forwards and its result back.
			await page.waitText("alpha", ".label", "v2:2");
			expect(await page.result(await page.call("alpha", "add", 1))).toEqual(ok("v2:3"));
			await page.waitText("alpha", ".label", "v2:3");
			expect(await page.result(await page.call("alpha", "code"))).toEqual(ok("v2"));
			expect((await page.states("alpha")).slice(settled)).toEqual([]);
			expect(await page.text("alpha", ".count")).toBe("3");
			expect(await page.result(await page.call("alpha", "visits"))).toEqual(ok(2));
			expect(await page.value("alpha", ".draft")).toBe("half-typed");
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	it("keeps the last values while the version is refused and binds once the page's code updates", async () => {
		const app = await oldPage();
		try {
			const result = await editAndApply(
				app,
				"counter",
				counterPlugin({ code: "v2", placement: "worker", contract: "v2" }),
			);
			expect(rolloutFailures(result)).toEqual([]);

			// Unbound `version` (§3): `failed { waiting }` with `contract_mismatch`.
			await page.waitState("alpha", "failed:waiting:contract_mismatch", 5000);
			// The last values stay on screen.
			expect(await page.text("alpha", ".label")).toBe("v1:2");
			expect(await page.text("alpha", ".count")).toBe("2");
			expect(await page.text("alpha", ".state")).toBe("failed");

			// The page's code updates (its contract copy at v2): the remounted view binds the new version.
			await editAndApply(
				app,
				"alpha",
				webPlugin({ name: "alpha", code: "2", counter: { placement: "worker", contract: "v2" } }),
			);
			await page.waitText("alpha", ".code", "alpha:2");
			await page.waitText("alpha", ".label", JSON.stringify({ text: "v2:2", code: "v2" }));
			await page.waitText("alpha", ".state", "live");
			expect(await page.result(await page.call("alpha", "add", { n: 1 }))).toEqual(ok({ text: "v2:3" }));
			expect(await page.result(await page.call("alpha", "visits"))).toEqual(ok(2));
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	it("keeps the last values while the type is removed and binds again when the type returns", async () => {
		const app = await oldPage();
		try {
			const result = await removeAndApply(app, "counter");
			expect(rolloutFailures(result)).toEqual([]);

			// Unbound `not_served` (§3): `failed { waiting }` with `unavailable` ("X is not served here").
			await page.waitState("alpha", "failed:waiting:unavailable", 5000);
			expect(await page.text("alpha", ".label")).toBe("v1:2");
			expect(await page.text("alpha", ".count")).toBe("2");

			// The type returns: the same reference binds again, the persisted count as it was.
			await editAndApply(app, "counter", counterPlugin({ code: "v1", placement: "worker" }));
			await page.waitState("alpha", "live");
			await page.waitText("alpha", ".state", "live");
			expect(await page.text("alpha", ".label")).toBe("v1:2");
			expect(await page.result(await page.call("alpha", "add", 1))).toEqual(ok("v1:3"));
			expect(await page.result(await page.call("alpha", "visits"))).toEqual(ok(2));
			expect(await page.value("alpha", ".draft")).toBe("half-typed");
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	it.each([
		["the version is refused", "failed:waiting:contract_mismatch", "contract_mismatch"],
		["the type is removed", "failed:waiting:unavailable", "unavailable"],
	] as const)(
		"fails a call at once with the cause while %s",
		async (change, waiting, code) => {
			const app = await oldPage();
			try {
				await page.hold("short", "alpha", PARK_MS);
				await page.waitState("short", "live");
				if (change === "the type is removed") await removeAndApply(app, "counter");
				else await editAndApply(app, "counter", counterPlugin({ code: "v2", placement: "worker", contract: "v2" }));
				await page.waitState("short", waiting, 5000);
				const started = Date.now();
				const failed = await page.result(await page.call("short", "add", 1));
				expect(failed).toMatchObject({ status: "error", code });
				// Not parked: well before the reference's `readyTimeout`.
				expect(Date.now() - started).toBeLessThan(PARK_MS);
			} finally {
				await app.app.close(context);
			}
		},
		120_000,
	);
});
