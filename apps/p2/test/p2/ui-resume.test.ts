// The installed app launching at `/` reopens the conversation that was open when it was last used, if that was
// recently; after a long break, or after going home, it starts at home (src/web/navigation.ts). A browser tab opening
// `/` starts at home.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

describe("reopening the last conversation", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		// Every page of this browser runs as the installed app (iOS reports it as navigator.standalone).
		await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `if (!sessionStorage.getItem("tab")) Object.defineProperty(navigator, "standalone", { value: true });`,
		});
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("reopens it within two hours of the last use, and starts at home after that or after going home", async () => {
		const session = await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Where I was",
			},
			BACKGROUND_CONTEXT,
		);
		const url = (path: string) => `http://127.0.0.1:${fixture.server.port}${path}`;
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea')`);

		// A launch at home shortly after: the conversation again.
		await browser.open(url("/"));
		await browser.wait(`location.pathname === '/s/${session.id}'`);

		// Last used three hours ago: home. (Written outside the app: the app records its last use as it closes.)
		await browser.open(url("/health"));
		await browser.evaluate(
			`localStorage.setItem("p2-last-conversation", JSON.stringify({ session: ${JSON.stringify(session.id)}, conversation: 1, at: Date.now() - 3 * 3600 * 1000 }))`,
		);
		await browser.open(url("/"));
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(await browser.evaluate<string>("location.pathname"), "/");

		// Going home forgets it: the next launch stays home.
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea')`);
		await browser.open(url("/"));
		await browser.wait(`location.pathname === '/s/${session.id}'`);
		await browser.metrics(1280, 900);
		await browser.click("button.new-session");
		await browser.wait(`location.pathname === '/'`);
		await browser.open(url("/"));
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(await browser.evaluate<string>("location.pathname"), "/");

		// A browser tab opening `/` starts at home, however recent the conversation.
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea')`);
		await browser.evaluate(`sessionStorage.setItem("tab", "1")`);
		await browser.open(url("/"));
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(await browser.evaluate<string>("location.pathname"), "/");
	});
});
