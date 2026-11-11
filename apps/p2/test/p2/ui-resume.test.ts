// The installed app launching at `/` reopens the conversation that was open when it was last used, if that was
// recently; after a long break, or after leaving conversations for the new-session screen, it starts at home
// (src/web/navigation.ts): the Familiar's session (plugins/familiar/web.tsx). A browser tab opening `/` starts at home.

import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Familiar } from "../../plugins/familiar/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("reopening the last conversation", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		// Every page of this browser runs as the installed app (iOS reports it as navigator.standalone).
		await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `if (!sessionStorage.getItem("tab")) Object.defineProperty(navigator, "standalone", { value: true });`,
		});
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("reopens it within two hours of the last use, and starts at home after that or after a new session", async () => {
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
		const familiar = await holdIn(fixture.browser(), Familiar, {}, "owner");
		const home = `/s/${await until(familiar.session, (value) => typeof value === "string")}`;
		await browser.wait(`location.pathname === '${home}'`);
		familiar.release();

		// The new-session screen forgets it: the next launch is at home.
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea')`);
		await browser.open(url("/"));
		await browser.wait(`location.pathname === '/s/${session.id}'`);
		await browser.metrics(1280, 900);
		await browser.click(".new-session");
		await browser.wait(`location.pathname === '/new'`);
		await browser.open(url("/"));
		await browser.wait(`location.pathname === '${home}'`);

		// A browser tab opening `/` starts at home, however recent the conversation.
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea')`);
		await browser.evaluate(`sessionStorage.setItem("tab", "1")`);
		await browser.open(url("/"));
		await browser.wait(`location.pathname === '${home}'`);
	});
});
