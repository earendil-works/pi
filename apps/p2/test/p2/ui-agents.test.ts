// Browser: a code mode script's one-shot agent opens from its card's row (read-only view), and a subagent is archived
// and restored from its bar, moving behind the sidebar's "N archived" row. Fake provider, disposable data.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { type Child, Subagents } from "../../plugins/subagents/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const SCRIPT = `return await tools.agent({ prompt: 'json {"ok":true}', label: "Check ok", schema: { type: "object" }, tools: [] });`;
const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const text = (selector: string) => `document.querySelector(${JSON.stringify(selector)})?.textContent`;

describe("one-shot agents and subagent archiving in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	let session: string;
	let list: RefIn<typeof Subagents, "reader">;
	let helper: Child;
	let agent: Child;

	before(async () => {
		fixture = await startFixture({ web: true });
		owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Agents" }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		list = await holdIn(owner, Subagents, {}, "reader");
		await chat.send({ text: "subagent", requestId: "spawn" }, BACKGROUND_CONTEXT);
		await until(list.children, (value) => value?.[session]?.length === 1);
		// The helper's report is a user message too: send the script once it has been answered.
		await until(
			chat.view,
			(value) => !live(value)?.run && JSON.stringify(value).includes("Echo: [answered, no reply needed]"),
			30_000,
		);
		await chat.send({ text: `codemode ${SCRIPT}`, requestId: "script" }, BACKGROUND_CONTEXT);
		const children = await until(list.children, (value) => value?.[session]?.length === 2);
		helper = children![session]!.find((child) => child.kind !== "agent")!;
		agent = children![session]!.find((child) => child.kind === "agent")!;
		assert.equal(agent.name, "Check ok");
		await until(chat.view, (value) => !live(value)?.run && JSON.stringify(value).includes('\\"ok\\":true'), 30_000);
		browser = await Browser.start();
		await browser.metrics(1280, 900);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("lists only named subagents in the sidebar and opens a one-shot agent from its script's row", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelector('.nested .tool-link') && !document.querySelector('.offline')`);
		// The sidebar counts the subagent, not the script's one-shot agent.
		assert.equal(await browser.evaluate(text(".session-header.has-subagents .subagent-toggle span")), "1");
		await browser.click(".nested .tool-link");
		await browser.wait(`document.querySelector('.nested-call .nested-open')?.textContent==='Check ok'`);
		assert.equal(await browser.evaluate(text(".nested-call .nested-name")), "agent");
		await browser.click(".nested-call .nested-open");
		await browser.wait(
			`location.pathname.endsWith('/c/${agent.conversationId}') && document.querySelector('.topbar .sub-tag')?.textContent==='agent'`,
		);
		assert.equal(await browser.evaluate(text(".topbar h1")), "agent Check ok");
		await browser.wait(`document.querySelector('.subagent-wrap .subagent-bar')`);
		assert.equal(
			await browser.evaluate(text(".subagent-wrap .subagent-bar span")),
			"One-shot agent of a script · read-only · Tools: none",
		);
		// Read-only: no composer, no model chip, no Archive; it shows its transcript.
		await browser.wait(`document.querySelector('.scroller')?.textContent.includes('{"ok":true}')`);
		assert.equal(await browser.evaluate(`document.querySelector('.composer')===null`), true);
		assert.equal(await browser.evaluate(`document.querySelector('.model-control')===null`), true);
		assert.equal(await browser.evaluate(`document.querySelector('.subagent-bar .text-action')===null`), true);
		assert.equal(await browser.evaluate(`document.querySelector('.subagent-row.active')===null`), true);
	});

	it("stops a working one-shot agent from its bar", async () => {
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send(
			{
				text: `codemode return await tools.agent({ prompt: "slow agent", label: "Slow", schema: { type: "object" } });`,
				requestId: "slow-script",
			},
			BACKGROUND_CONTEXT,
		);
		const children = await until(list.children, (value) => value?.[session]?.length === 3);
		const slow = children![session]!.find((child) => child.name === "Slow")!;
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}/c/${slow.conversationId}`);
		await browser.metrics(390, 844);
		await browser.wait(`document.querySelector('.subagent-bar .round.stop')`);
		// The read-only view has no composer, so its bar carries the scroll-to-bottom button.
		await browser.wait(
			`(() => { const e=document.querySelector('.scroller');return e && e.scrollHeight > e.clientHeight + 300; })()`,
		);
		const center = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r=document.querySelector('.scroller').getBoundingClientRect();return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, deltaX: 0, deltaY: -3000 });
		await browser.wait(`document.querySelector('.subagent-wrap .to-bottom')`);
		await browser.click(".subagent-wrap .to-bottom");
		await browser.wait(`document.querySelector('.subagent-wrap .to-bottom')===null`);
		await browser.click(".subagent-bar .round.stop");
		await browser.wait(`document.querySelector('.subagent-bar .round.stop')===null`);
		// The script's call rejects: the agent did not answer.
		const view = await until(
			chat.view,
			(value) => !live(value)?.run && JSON.stringify(value).includes("The agent did not answer"),
			30_000,
		);
		assert.ok(view);
		chat.release();
		await browser.metrics(1280, 900);
	});

	it("archives a subagent behind the sidebar's archived row and restores it", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}/c/${helper.conversationId}`);
		await browser.wait(`document.querySelector('.subagent-bar .text-action')?.textContent==='Archive'`);
		assert.equal(await browser.evaluate(text(".topbar .sub-tag")), "subagent");
		assert.equal(await browser.evaluate(`document.querySelector('.composer textarea')!==null`), true);
		await browser.click(".subagent-bar .text-action");
		await until(
			list.children,
			(value) => value?.[session]?.find((child) => child.kind !== "agent")?.archived === true,
		);
		await browser.wait(`document.querySelector('.subagent-bar .text-action')?.textContent==='Restore'`);
		assert.match(String(await browser.evaluate(text(".subagent-wrap .subagent-bar span"))), / · archived$/);
		// Viewing an archived subagent opens its row.
		await browser.wait(`document.querySelector('.subagent-stored')?.getAttribute('aria-expanded')==='true'`);
		assert.equal(await browser.evaluate(text(".subagent-stored .session-title")), "1 archived");
		assert.equal(
			await browser.evaluate(`document.querySelectorAll('.subagent-row:not(.subagent-stored)').length`),
			1,
		);
		await browser.click(".subagent-bar .text-action");
		await until(list.children, (value) => !value?.[session]?.find((child) => child.kind !== "agent")?.archived);
		await browser.wait(`document.querySelector('.subagent-bar .text-action')?.textContent==='Archive'`);
		await browser.wait(`document.querySelector('.subagent-stored')===null`);
		assert.equal(await browser.evaluate(`document.querySelectorAll('.subagent-row').length`), 1);
	});

	// Pi Mobile 24e3fccdd: a subagent spawned with its own cwd shows it in its bar and spawn card, and its workspace
	// panel opens there.
	it("shows a subagent's own cwd and opens its workspace panel there", async () => {
		const worktree = join(fixture.workspace, "worktree");
		mkdirSync(worktree);
		writeFileSync(join(worktree, "marker.txt"), "inside\n");
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const spawn = { action: "spawn", name: "wt", message: "hi", cwd: "worktree", tools: [] };
		await chat.send({ text: `subagent ${JSON.stringify(spawn)}`, requestId: "spawn-wt" }, BACKGROUND_CONTEXT);
		const children = await until(list.children, (value) => Boolean(value?.[session]?.some((c) => c.name === "wt")));
		const wt = children![session]!.find((child) => child.name === "wt")!;
		assert.deepEqual(wt.location, { cwd: worktree, env: null });
		await until(
			chat.view,
			(value) => !live(value)?.run && JSON.stringify(value).includes("Echo: [answered, no reply needed]"),
		);
		chat.release();
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		// The spawn card's details name the cwd relative to the session's.
		const card = `[...document.querySelectorAll('.tool')].find(e=>e.querySelector('.tool-summary')?.textContent.startsWith('wt'))`;
		await browser.wait(`${card}?.querySelector('.tool-expand')`);
		await browser.evaluate(`${card}.querySelector('.tool-expand').click()`);
		await browser.wait(`${card}?.querySelector('.tool-sub .mono')`);
		assert.equal(
			await browser.evaluate(`${card}.querySelector('.tool-sub .mono').textContent`),
			"faux/faux-1 · thinking off · tools none · cwd worktree",
		);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}/c/${wt.conversationId}`);
		await browser.wait(`document.querySelector('.subagent-wrap .subagent-bar span')`);
		assert.equal(
			await browser.evaluate(text(".subagent-wrap .subagent-bar span")),
			`Tools: none · in ${worktree.replace(/^\/home\/[^/]+/, "~")}`,
		);
		// The sidebar row shows its own location (it stays there when the session moves).
		assert.equal(
			await browser.evaluate(text(".subagent-row.active .subagent-location")),
			worktree.replace(/^\/home\/[^/]+/, "~"),
		);
		await browser.click('button[aria-label="Workspace files and changes"]');
		await browser.wait(`[...document.querySelectorAll('.workspace-name')].some(e=>e.textContent==='marker.txt')`);
		assert.equal(await browser.evaluate(`document.querySelectorAll('.workspace-name').length`), 1);
		assert.equal(
			await browser.evaluate(text(".workspace-head .workspace-location")),
			worktree.replace(/^\/home\/[^/]+/, "~"),
		);
	});
});
