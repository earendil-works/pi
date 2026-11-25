// The Familiar in the owner's page (plugins/familiar/web.tsx), named "Ask Pi": home and its row above the sidebar's "New
// session" open its session (made on first use), which no rollup lists; an archived one stays archived until the row is
// used.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Familiar } from "../../plugins/familiar/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("the Familiar as home", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		await fixture
			.browser()
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("is home and the sidebar's first row, made on first use, and leaves the rollups", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		await sessions.create({ cwd: fixture.workspace, title: "Ordinary" }, BACKGROUND_CONTEXT);
		await browser.metrics(1280, 900);
		// Home makes the Familiar and shows its session, as "Ask Pi".
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		const familiar = await holdIn(owner, Familiar, {}, "owner");
		const id = await until(familiar.session, (value) => typeof value === "string");
		await browser.wait(`location.pathname.startsWith('/s/${id}')`);
		assert.equal(
			(await until(sessions.sessions, (rows) => rows?.some((row) => row.id === id)))?.find((row) => row.id === id)
				?.title,
			"Ask Pi",
		);
		// The list starts with its row (the Pi logo as its icon), selected while it shows, then "New session"; the header's
		// logo is only a logo.
		await browser.wait(
			`document.querySelector('.sidebar-start .nav-row.selected:has(.nav-marker .pi-logo) > .familiar-entry.active')`,
		);
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.sidebar-start .nav-label')].map((label) => label.textContent)`,
			),
			["Ask Pi", "New session"],
		);
		assert.ok(await browser.evaluate<boolean>(`document.querySelector('.drawer-top .brand > .pi-logo') !== null`));
		// No rollup lists it.
		await browser.wait(
			`[...new Set([...document.querySelectorAll('.sidebar-nav .session-main .session-title')].map(e=>e.textContent))].join()==='Ordinary'`,
		);
		if (process.env.P2_SCREENSHOT) {
			const { data } = (await browser.call("Page.captureScreenshot", { format: "png" })) as { data: string };
			writeFileSync(process.env.P2_SCREENSHOT, Buffer.from(data, "base64"));
		}
		// "New session" opens the new-session screen at /new; its row returns.
		await browser.click(".new-session");
		await browser.wait(
			`location.pathname === '/new' && document.querySelector('.nav-row.selected > .new-session') && !document.querySelector('.familiar-entry.active')`,
		);
		await browser.click(".familiar-entry");
		await browser.wait(
			`location.pathname.startsWith('/s/${id}') && document.querySelector('.familiar-entry.active')`,
		);
		// Archived, home leaves it archived and shows the new-session screen; its row restores it.
		await sessions.archive({ id: String(id) }, BACKGROUND_CONTEXT);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(`location.pathname === '/new'`);
		await browser.click(".familiar-entry");
		await browser.wait(`location.pathname.startsWith('/s/${id}')`);
		await until(sessions.sessions, (rows) => rows?.find((row) => row.id === id)?.archivedAt === null);
		familiar.release();
		sessions.release();
	});
});
