// The Familiar's sidebar entry (plugins/familiar/web.tsx): above the rollups for the owner, opening its session (made on
// the first tap), which is then listed there and not in any rollup.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Familiar } from "../../plugins/familiar/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("the Familiar's drawer entry", { skip: !browserTests }, () => {
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

	it("sits above the rollups, makes and opens its session, which leaves the rollups", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		await sessions.create({ cwd: fixture.workspace, title: "Ordinary" }, BACKGROUND_CONTEXT);
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(`document.querySelector('.familiar-entry') && !document.querySelector('.offline')`);
		// First in the list: before every rollup.
		assert.equal(
			await browser.evaluate<boolean>(
				`Boolean(document.querySelector('.session-scroll .familiar-group').compareDocumentPosition(document.querySelector('.sidebar-nav')) & Node.DOCUMENT_POSITION_FOLLOWING)`,
			),
			true,
		);
		await browser.click(".familiar-entry");
		const familiar = await holdIn(owner, Familiar, {}, "owner");
		const id = await until(familiar.session, (value) => typeof value === "string");
		await browser.wait(`location.pathname.startsWith('/s/${id}')`);
		await browser.wait(`document.querySelector('.familiar-entry.active')`);
		// Its row is the entry: no rollup lists it.
		await browser.wait(
			`[...new Set([...document.querySelectorAll('.sidebar-nav .session-main .session-title')].map(e=>e.textContent))].join()==='Ordinary'`,
		);
		if (process.env.P2_SCREENSHOT) {
			const { data } = (await browser.call("Page.captureScreenshot", { format: "png" })) as { data: string };
			writeFileSync(process.env.P2_SCREENSHOT, Buffer.from(data, "base64"));
		}
		familiar.release();
		sessions.release();
	});
});
