// The owner's Discord sheets. More › Discord: the bots (the first release's discord.json migrated to one), Add bot (a
// refused token shows Discord's reason and is not kept), a bot's sheet (its status, invite and servers once connected,
// Remove bot). A session's sheet → Discord: the link form, Link disabled while choices are missing, Back to the Session
// sheet. Tokens never reach the logs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { processLogs } from "../../src/runtime/logs.ts";
import { Browser, browserTests } from "./browser.ts";
import { holdIn, poll, startFixture } from "./helpers.ts";

const LEGACY = "MTIzNDU2Nzg5MDEyMzQ1Njc4.legacy-0.discord-token-sentinel";
const ADDED = "MTIzNDU2Nzg5MDEyMzQ1Njc4.added-0.discord-token-sentinel";

const dialog = "document.querySelector('[role=dialog]')";
const text = (needle: string) => `${dialog}?.textContent.includes(${JSON.stringify(needle)})`;
const press = (label: string) =>
	`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.includes(${JSON.stringify(label)})).click()`;

test(
	"owner Discord sheets: bots, add bot, a bot's sheet, a session's link form",
	{ skip: !browserTests, timeout: 120_000 },
	async (t) => {
		// The first release kept one token as `{ token }`: it becomes the first bot (Discord refuses this one).
		const dataDir = mkdtempSync(join(tmpdir(), "p2-discord-ui-"));
		t.after(() => rmSync(dataDir, { recursive: true, force: true }));
		const path = join(dataDir, "discord.json");
		writeFileSync(path, JSON.stringify({ token: LEGACY }), { mode: 0o600 });
		const fixture = await startFixture({ web: true, dataDir });
		t.after(() => fixture.close());
		const migrated = JSON.parse(readFileSync(path, "utf8")) as { bots: Record<string, { token: string }> };
		assert.equal(migrated.bots.bot1?.token, LEGACY, "the first release's token is bot1");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		const session = (
			await (
				await holdIn(fixture.browser(), Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Listener" }, BACKGROUND_CONTEXT)
		).id;
		const browser = await Browser.start();
		await browser.signIn(fixture.owner);
		t.after(() => browser.close());
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.openSettings("Discord");
		await browser.wait(`${text("Discord bot")} && ${text("Not connected")}`);
		assert(!(await browser.evaluate<boolean>(text("Bind a channel"))), "no channels in the global sheet");

		// Add bot: Discord refuses the token; the sheet says so and keeps nothing.
		await browser.evaluate(press("Add bot"));
		await browser.wait(
			`document.querySelector('[role=dialog] [aria-label="Add bot"] input[aria-label="Bot token"]')`,
		);
		await browser.evaluate(
			`(()=>{const e=document.querySelector('input[aria-label="Bot token"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(ADDED)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
		);
		await browser.click("[role=dialog] button[type=submit]");
		await browser.wait(`${dialog}?.querySelector('.notice.error')`);
		assert.match(await browser.evaluate<string>(`${dialog}.querySelector('.notice.error').textContent`), /Discord/);
		assert.deepEqual(
			Object.keys(JSON.parse(readFileSync(path, "utf8")).bots),
			["bot1"],
			"a refused token is not kept",
		);
		await browser.click("[role=dialog] button[aria-label=Back]");
		await browser.wait(text("Add bot"));

		// The bot's sheet: why it is not connected, its (empty) linked sessions, Remove bot.
		await browser.evaluate(press("Discord bot"));
		await browser.wait(`${text("Remove bot")} && ${text("Linked sessions")}`);
		assert(await browser.evaluate<boolean>(text("Discord refused the token.")));
		await browser.evaluate(press("Remove bot"));
		await browser.wait(`[...document.querySelectorAll('[role=dialog] button')].some(e=>e.textContent==='Remove')`);
		await browser.evaluate(
			`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Remove').click()`,
		);
		await browser.wait(text("No bots yet."));
		await poll(() => Object.keys(JSON.parse(readFileSync(path, "utf8")).bots).length === 0);

		// The session's sheet → Discord: the link form says what is missing; Back returns to the Session sheet.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelector('.topbar button[aria-label="Session options"]')`);
		await browser.click('.topbar button[aria-label="Session options"]');
		await browser.wait(text("Not linked"));
		await browser.evaluate(press("Discord"));
		await browser.wait(text("Still to pick"));
		assert(await browser.evaluate<boolean>(`${dialog}.querySelector('button[type=submit]').disabled`));
		assert.match(await browser.evaluate<string>(`${dialog}.textContent`), /Still to pick: a bot, .*a sandbox\./);
		assert(await browser.evaluate<boolean>(text("No connected bot.")));
		await browser.click("[role=dialog] button[aria-label=Back]");
		await browser.wait(text("Not linked"));
		const logged = [...processLogs.sources()].flatMap((source) =>
			processLogs.lines(source.id).map((line) => line.text),
		);
		assert(!logged.some((line) => line.includes("discord-token-sentinel")), "tokens are never logged");
	},
);

test(
	"a linked session's Discord sheet: fixed bot, channel and sandbox; who may wake Pi and resources saved in place",
	{ skip: !browserTests, timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture({ web: true });
		t.after(() => fixture.close());
		const browser = await Browser.start();
		await browser.signIn(fixture.owner);
		t.after(() => browser.close());
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}`);
		await browser.wait("document.querySelector('.app')");
		await browser.loadFixture("discord-linked.ts");
		await browser.wait("document.querySelector('.discord-form')");
		const body = () => browser.evaluate<string>("document.querySelector('.discord-form').innerText");
		const checked = (label: string) =>
			browser.evaluate<boolean>(
				`[...document.querySelectorAll('.discord-form label.check')].find(e=>e.textContent.includes(${JSON.stringify(label)})).querySelector('input').checked`,
			);
		const tick = (label: string) =>
			browser.evaluate(
				`[...document.querySelectorAll('.discord-form label.check')].find(e=>e.textContent.includes(${JSON.stringify(label)})).querySelector('input').click()`,
			);
		const save = "document.querySelector('.discord-form button[type=submit]')";
		// What is fixed shows as rows, not fields.
		const text = await body();
		for (const fixed of ["pixi#6938", "Guild › #general", "box1"]) assert(text.includes(fixed), fixed);
		assert.equal(await browser.evaluate<number>("document.querySelectorAll('.discord-form select').length"), 0);
		// The saved access is what shows; Save waits for a change.
		assert.equal(await checked("@maintainers"), true);
		assert.equal(await checked("@helpers"), false);
		assert.equal(await checked("tracker"), false);
		assert.equal(await checked("Your global AGENTS.md"), true);
		assert.equal(
			await browser.evaluate<string>("document.querySelector('.discord-form textarea').value"),
			"123456789",
		);
		assert(await browser.evaluate<boolean>(`${save}.disabled`));
		// Nobody left to wake Pi: not savable, and it says why.
		await tick("@maintainers");
		await browser.evaluate(
			"(()=>{const e=document.querySelector('.discord-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()",
		);
		await browser.wait(
			`${save}.disabled && document.querySelector('.discord-form').innerText.includes('Pick who may wake Pi.')`,
		);
		// A role, an MCP server and a capability: saved in place.
		await tick("@helpers");
		await tick("tracker");
		await tick("Forward ports");
		await browser.wait(`!${save}.disabled`);
		await browser.click(".discord-form button[type=submit]");
		await browser.wait("document.querySelector('.discord-form').innerText.includes('Saved: in effect now.')");
		assert.deepEqual(await browser.evaluate("window.discordCalls"), [
			{
				save: {
					wake: { anyone: false, users: [], roles: ["r2"] },
					lock: { mcp: ["docs", "tracker"], projectMcp: false, instructions: true, capabilities: ["ports"] },
				},
			},
		]);
		// A refused save says why and keeps the edits; Undo goes back to what is saved.
		await tick("Anyone in the channel");
		await browser.evaluate("window.failNextSave = true");
		await browser.click(".discord-form button[type=submit]");
		await browser.wait(
			"document.querySelector('.discord-form .notice.error')?.textContent.includes('The session is busy')",
		);
		assert.equal(await checked("Anyone in the channel"), true);
		await browser.evaluate(
			"[...document.querySelectorAll('.discord-form button')].find(e=>e.textContent==='Undo changes').click()",
		);
		await browser.wait(`${save}.disabled`);
		await browser.evaluate(
			"[...document.querySelectorAll('.discord-form button')].find(e=>e.textContent==='Unlink').click()",
		);
		await poll(async () => (await browser.evaluate<unknown[]>("window.discordCalls")).includes("unlink"));
	},
);
