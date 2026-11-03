// A long conversation in the browser: opening it receives only the newest entries (plugins/chat/window.ts), scrolling
// up pages in the rest, and switching to another session and back keeps the held view and its pages (a lingering
// hold, src/runtime/linger.ts): nothing is sent again.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions, SessionTransfer } from "../../plugins/sessions/contract.ts";
import { bigSessionEntries } from "../fixtures/big-session.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

/** Counts what the page's WebSockets receive (`window.__received`, characters). */
const COUNT_RECEIVED = `(() => {
	window.__received = 0;
	const Native = WebSocket;
	window.WebSocket = class extends Native {
		constructor(...args) {
			super(...args);
			this.addEventListener("message", (event) => { window.__received += String(event.data).length; });
		}
	};
})()`;

describe("long conversation in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, long: string, other: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		if (sessions.variant !== "owner") throw new Error("owner expected");
		long = (await sessions.create({ cwd: fixture.workspace, title: "Long one" }, BACKGROUND_CONTEXT)).id;
		other = (await sessions.create({ cwd: fixture.workspace, title: "Other one" }, BACKGROUND_CONTEXT)).id;
		const entries = bigSessionEntries(600, 4_000);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(SessionTransfer, { session: long })).seed({ entries }, ctx),
			BACKGROUND_CONTEXT,
		);
		browser = await Browser.start();
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: COUNT_RECEIVED });
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("opens with the newest entries, pages in the rest, and switches back without resending", async () => {
		await browser.metrics(1200, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${long}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Fixed module 75')`);
		const opened = await browser.evaluate<number>("window.__received");
		assert.ok(opened < 1_500_000, `first view: ${opened} characters`);
		assert.equal(
			await browser.evaluate<boolean>(
				`document.querySelector('.messages').textContent.includes('module 1 and fix')`,
			),
			false,
		);
		// Scrolling up pages in older entries until the conversation's start.
		await browser.wait(`(() => {
			const scroller = document.querySelector('.scroller');
			scroller.scrollTop = 0;
			scroller.dispatchEvent(new Event('scroll'));
			return document.querySelector('.messages').textContent.includes('module 1 and fix') && !document.querySelector('.earlier');
		})()`);
		// Another session and back: the held view and its pages are still there, nothing is sent again.
		const before = await browser.evaluate<number>("window.__received");
		const row = (title: string) =>
			`[...document.querySelectorAll('.session-row button')].find((button) => button.textContent.includes(${JSON.stringify(title)}))?.click() ?? true`;
		await browser.evaluate(row("Other one"));
		await browser.wait(`document.querySelector('.topbar h1')?.textContent === 'Other one'`);
		await browser.evaluate(row("Long one"));
		await browser.wait(`document.querySelector('.topbar h1')?.textContent === 'Long one'`);
		// It opens at the bottom (only the rows near the viewport are rendered); its start is a scroll away.
		await browser.wait(`(() => {
			const scroller = document.querySelector('.scroller');
			if (scroller) scroller.scrollTop = 0;
			return Boolean(document.querySelector('.messages')?.textContent.includes('module 1 and fix'));
		})()`);
		const switched = (await browser.evaluate<number>("window.__received")) - before;
		assert.ok(switched < 100_000, `switching back received ${switched} characters`);
		assert.ok(other);
	});

	it("a search hit opens the conversation at an old message, paging back to it", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${other}`);
		await browser.wait(`document.querySelector('.topbar h1')?.textContent === 'Other one'`);
		await browser.evaluate(
			`(()=>{const e=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'module 2 and fix');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
		);
		await browser.wait(
			`[...document.querySelectorAll('.hit')].some((hit) => hit.textContent.includes('module 2 and fix'))`,
		);
		await browser.evaluate(
			`[...document.querySelectorAll('.hit')].find((hit) => hit.textContent.includes('module 2 and fix')).click()`,
		);
		await browser.wait(
			`[...document.querySelectorAll('[data-entry].flash')].some((element) => element.textContent.includes('module 2 and fix'))`,
		);
	});
});
