// The app starts without its server once it was opened (public/sw.js keeps the page and its bundle files), and shows
// the conversation kept on the device (src/web/conversation-cache.ts) with a usable composer.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("the app without its server", { skip: !browserTests }, () => {
	let fixture: Fixture | undefined;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("starts from the service worker and shows the kept conversation", async () => {
		const server = fixture;
		assert.ok(server);
		const owner = server.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: server.workspace,
				title: "Away",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		await chat.send({ text: "still here offline", requestId: "away" }, BACKGROUND_CONTEXT);
		await until(
			chat.view,
			(view) => JSON.stringify(view?.entries ?? []).includes("Echo: still here offline"),
			30_000,
		);
		stop();
		chat.release();

		const page = `http://127.0.0.1:${server.server.port}/s/${session.id}`;
		await browser.metrics(390, 844);
		await browser.open(page);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: still here offline')`);
		// The worker kept the page and the bundle it names; the conversation is kept a second after it settles.
		await browser.wait(`(async () => {
			const shell = await (await caches.open('p2-app-shell')).match('/');
			if (!shell) return false;
			const script = /src="(\\/__p2_web\\/[^"]+)"/.exec(await shell.text())?.[1];
			return Boolean(script && (await caches.match(script)));
		})()`);
		await new Promise((resolve) => setTimeout(resolve, 1_500));

		// The server is gone: the app still opens, with the conversation and a composer, and says it is offline.
		await server.close();
		fixture = undefined;
		await browser.open(page);
		await browser.wait(`Boolean(document.querySelector('.offline'))`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: still here offline')`);
		assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.composer textarea'))`));
	});
});
