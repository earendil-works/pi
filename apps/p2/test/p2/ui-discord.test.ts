// The owner's Discord sheet: opened from the sidebar foot, it explains the setup without a bot; a refused token shows
// Discord's reason, is kept 0600 in discord.json until removed, and never reaches the logs.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processLogs } from "../../src/runtime/logs.ts";
import { Browser, browserTests } from "./browser.ts";
import { poll, startFixture } from "./helpers.ts";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.fake-0.discord-token-sentinel";

test(
	"owner Discord sheet: setup hint, a refused token, removing the bot",
	{ skip: !browserTests, timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture({ web: true });
		t.after(() => fixture.close());
		const browser = await Browser.start();
		t.after(() => browser.close());
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(`[...document.querySelectorAll('.foot-button')].some(e=>e.textContent==='Discord')`);
		await browser.evaluate(
			`[...document.querySelectorAll('.foot-button')].find(e=>e.textContent==='Discord').click()`,
		);
		await browser.wait(
			`document.querySelector('[role=dialog][aria-label=Discord]')?.textContent.includes('Message Content Intent')`,
		);
		assert(
			await browser.evaluate<boolean>(
				`document.querySelector('[role=dialog]').textContent.includes('No channels bound.')`,
			),
		);
		await browser.evaluate(
			`(()=>{const e=document.querySelector('input[aria-label="Bot token"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(TOKEN)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
		);
		await browser.click("[role=dialog] form.inline-form button[type=submit]");
		// Discord refuses it (or is unreachable): either way the sheet shows why, and offers to remove the bot.
		await browser.wait(
			`[...document.querySelectorAll('[role=dialog] button')].some(e=>e.textContent==='Remove the bot') && !document.querySelector('[role=dialog]').textContent.includes('Connecting…')`,
		);
		const path = join(fixture.dataDir, "discord.json");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).token, TOKEN);
		const logged = [...processLogs.sources()].flatMap((source) =>
			processLogs.lines(source.id).map((line) => line.text),
		);
		assert(!logged.some((line) => line.includes("discord-token-sentinel")), "the token is never logged");
		await browser.evaluate(
			`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Remove the bot').click()`,
		);
		await browser.wait(`document.querySelector('[role=dialog]').textContent.includes('Message Content Intent')`);
		await poll(() => JSON.parse(readFileSync(path, "utf8")).token === undefined);
	},
);
