// Reload suite, a case the table leaves out (the audit's "jobs running across a reload"; design §15 "Versions"): a job
// run started from the page, running on a worker while its object restarts (with or without natives: every reload
// restarts). The in-memory run ends `aborted { reload }` at the old attempt's seal and `finish` runs on the new code.
// The page watches the finished runs' entries.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	editAndApply,
	latches,
	ReloadPage,
	rolloutFailures,
	rolloutFates,
	startReloadApp,
} from "../fixtures/reload/app.ts";
import { LATCH_PLUGIN, tasksPlugin } from "../fixtures/reload/plugins.ts";
import { Browser, CHROMIUM } from "../web/browser.ts";

describe.skipIf(CHROMIUM === undefined)("a job running across a reload", () => {
	let browser: Browser;
	let page: ReloadPage;

	beforeAll(async () => {
		browser = await Browser.start();
		page = new ReloadPage(browser);
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it.each([
		["pure code", false],
		["code holding natives", true],
	] as const)(
		"across a restart of %s",
		async (_change, native) => {
			const fate = "restarted";
			const entry = "v2-finish(aborted:reload)";
			const app = await startReloadApp({ latch: LATCH_PLUGIN, tasks: tasksPlugin("v1", native) });
			const hand = await latches(app, "worker");
			try {
				await page.signIn(app, []);
				await page.hold("tasks", "tasks", 10_000, "p1", "entries");
				await page.waitState("tasks", "live");
				const started = await page.result(await page.call("tasks", "start", "a"));
				expect(started).toMatchObject({ status: "ok" });
				await hand.entered("a");

				const result = await editAndApply(app, "tasks", tasksPlugin("v2", native));
				expect(rolloutFailures(result)).toEqual([]);
				expect(rolloutFates(result)).toContain(`project/project|p1: reload.runner ${fate}`);
				await hand.open("a");
				await browser.wait(
					`globalThis.reload.frames.tasks?.some((frame) => Array.isArray(frame) && frame.length > 0)`,
				);
				const frames = await page.frames("tasks");
				expect(frames.at(-1)).toEqual([entry]);
				// A run started now runs on the new code.
				await page.call("tasks", "start", "b");
				await hand.entered("b");
				await hand.open("b");
				await browser.wait("globalThis.reload.frames.tasks?.at(-1)?.length === 2");
				expect((await page.frames("tasks")).at(-1)).toEqual([entry, "v2-finish(done:run-v2:b)"]);
			} finally {
				await hand.open("a");
				await hand.open("b");
				await app.app.close(context);
			}
		},
		120_000,
	);
});
