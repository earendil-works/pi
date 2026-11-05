// `useOptimisticCall` (docs/optimistic-ui.md) in a real browser: a tap shows its guess at once and the pending state
// while the call is in flight; the server's value replaces the guess when the call passes; a refused call rolls the
// value back and shows the error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser, browserTests } from "./browser.ts";
import { startFixture } from "./helpers.ts";

test(
	"useOptimisticCall: guess at once, server value on success, visible rollback on refusal",
	{ skip: !browserTests, timeout: 60_000 },
	async () => {
		const fixture = await startFixture({ web: true, plugins: ["web-shell"] });
		let browser: Browser | undefined;
		try {
			browser = await Browser.start();
			await browser.open(`http://127.0.0.1:${fixture.server.port}`);
			await browser.wait("document.body");
			await browser.loadFixture("optimistic.ts");
			await browser.wait("document.querySelector('#switch')?.textContent === 'off'");
			const text = (selector: string) =>
				browser!.evaluate<string>(`document.querySelector('${selector}').textContent`);
			// The guess shows while the call is held open, with the pending state.
			await browser.evaluate("document.querySelector('#switch').click()");
			await browser.wait("document.querySelector('#switch').textContent === 'on'");
			assert.equal(await text("#pending"), "pending");
			await browser.evaluate("window.settleCall({ pass: true })");
			await browser.wait("document.querySelector('#pending').textContent === 'idle'");
			assert.equal(await text("#switch"), "on");
			// Refused: the guess goes, the value is the server's again, and the error is shown.
			await browser.evaluate("document.querySelector('#switch').click()");
			await browser.wait("document.querySelector('#switch').textContent === 'off'");
			await browser.evaluate("window.settleCall({ refuse: 'not allowed' })");
			await browser.wait("document.querySelector('#switch').textContent === 'on'");
			assert.equal(await text("#error"), "not allowed");
			assert.equal(await text("#pending"), "idle");
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);
