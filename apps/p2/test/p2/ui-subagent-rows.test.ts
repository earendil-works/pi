// A session's subagent items in the sidebar, in Chromium, end to end: pi's working dots while a subagent works, a red
// dot after a provider error (its label says why), nothing once stopped or idle; the age of its newest message in the
// session's age column; its model and where it works as its tooltip. Its action on hover: Cancel stops only its run,
// Archive moves it under "N archived". The fake provider answers; a local provider that refuses every request
// (HTTP 400) makes one subagent fail.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { SESSIONS_OWNER, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { type Child, Subagents } from "../../plugins/subagents/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdWith, startFixture, until } from "./helpers.ts";
import { type BaselineOffset, baselineOffsets } from "./sidebar-baselines.ts";

/** What a subagent's item shows: its details' text, its status mark (`dots`, `failed: <label>`, none), its tooltip. */
type Shown = { details: string; status: string; tooltip: string };

describe("subagent rows in the sidebar", { skip: !browserTests }, () => {
	let provider: Server;
	let fixture: Fixture;
	let browser: Browser;
	let session: string;
	let children: Child[] = [];

	before(async () => {
		provider = createServer((_request, response) => {
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: "fixture bad request", type: "invalid_request_error" } }));
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		fixture = await startFixture({ web: true });
		// Before the session's worker starts, which reads it.
		await writeFile(
			join(fixture.dataDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
						apiKey: "fixture",
						api: "openai-completions",
						models: [{ id: "m1", contextWindow: 8000, maxTokens: 100 }],
					},
				},
			}),
		);
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		const sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		session = (await sessions.create({ cwd: fixture.workspace, title: "Subagent rows" }, BACKGROUND_CONTEXT)).id;
		const chat = await holdWith(owner, Chat, { session, conversation: 1 }, ...CHAT_PARTICIPANT);
		const agents = await holdWith(owner, Subagents, {}, "children");
		await chat.send({ text: "subagent", requestId: "helper" }, BACKGROUND_CONTEXT);
		await until(agents.children, (value) => value?.[session]?.length === 1);
		const spawn = { action: "spawn", name: "failing", model: "local/m1", message: "hello failing", tools: ["read"] };
		await chat.send({ text: `subagent ${JSON.stringify(spawn)}`, requestId: "failing" }, BACKGROUND_CONTEXT);
		const listed = await until(
			agents.children,
			(value) => value?.[session]?.find((child) => child.name === "failing")?.failure !== undefined,
			30_000,
		);
		children = listed?.[session] ?? [];
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(1280, 800);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		const toggle = `document.querySelector('.sidebar-section[data-key=other] .session-header.has-subagents .subagent-toggle')`;
		await browser.wait(toggle);
		if ((await browser.evaluate<string>(`${toggle}.getAttribute('aria-expanded')`)) === "false")
			await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`${row("helper")} && ${row("failing")}`);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
		await new Promise((resolve) => provider?.close(resolve));
	});

	const row = (name: string) =>
		`[...document.querySelectorAll('.sidebar-section[data-key=other] .nav-row:has(> .subagent-row)')].find(e=>e.querySelector('.session-title').textContent===${JSON.stringify(name)})`;
	const shown = (name: string) =>
		browser.evaluate<Shown>(
			`(() => { const e = ${row(name)}; const m = e.querySelector('.nav-marker > *'); return { details: e.querySelector('.nav-details')?.textContent ?? '', status: !m ? '' : m.classList.contains('pi-dots') ? 'dots' : m.classList.contains('failed-dot') ? 'failed: ' + m.getAttribute('aria-label') : m.className, tooltip: e.querySelector('.subagent-row').title }; })()`,
		);
	/** Moves the mouse over item `name`, which shows its action instead of its age. */
	const hover = async (name: string) => {
		const at = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = ${row(name)}.querySelector('.session-title').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	};
	const helper = () => children.find((child) => child.name === "helper")!;
	const failure = '400: {"message":"fixture bad request","type":"invalid_request_error"}';

	it("shows an idle subagent's age in its session's age column, no status mark, and its model and location as its tooltip", async () => {
		await browser.wait(`${row("helper")}.querySelector('.item-age')?.textContent === 'now'`);
		assert.deepEqual(await shown("helper"), {
			details: "now",
			status: "",
			tooltip: "faux-1 · off\nFollows the session",
		});
		const edges = await browser.evaluate<number[]>(
			`[${row("helper")}.closest('.session-row').querySelector('.session-header .item-age'), ${row("helper")}.querySelector('.item-age')].map(e=>Math.round(e.getBoundingClientRect().right))`,
		);
		assert.equal(edges[0], edges[1], "the subagent's age ends where the session's does");
	});

	it("shows a provider error as a red dot labelled with its text, and no word at its end", async () => {
		assert.deepEqual(await shown("failing"), {
			details: "now",
			status: `failed: ${failure}`,
			tooltip: `m1 · off\nFollows the session\nFailed: ${failure}`,
		});
	});

	it("shows pi's dots while a subagent works; its Cancel stops its run only", async () => {
		const owner = fixture.browser();
		const sub = await holdWith(owner, Chat, { session, conversation: helper().conversationId }, ...CHAT_PARTICIPANT);
		const main = await holdWith(owner, Chat, { session, conversation: 1 }, ...CHAT_PARTICIPANT);
		const status = await holdWith(owner, SessionStatus, {}, "statuses");
		await main.send({ text: "slow main", requestId: "slow-main" }, BACKGROUND_CONTEXT);
		await sub.send({ text: "slow rows", requestId: "slow" }, BACKGROUND_CONTEXT);
		await browser.wait(`${row("helper")}.querySelector('.nav-marker > .pi-dots[role=img][aria-label=Working]')`);
		assert.equal((await shown("helper")).tooltip, "faux-1 · off\nFollows the session");
		await hover("helper");
		const cancel = `.sidebar-section[data-key=other] .conversation-row > button.item-action[data-action=cancel][aria-label="Stop helper"]`;
		await browser.wait(`getComputedStyle(document.querySelector('${cancel}')).opacity === '1'`);
		// The action takes the age's place.
		assert.equal(
			await browser.evaluate<string>(`getComputedStyle(${row("helper")}.querySelector('.nav-details')).visibility`),
			"hidden",
		);
		await browser.click(cancel);
		await until(status.statuses, (states) => !states?.[session]?.busy.includes(helper().conversationId));
		// Stopped, not finished on its own.
		const last = await until(sub.view, (view) => !(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		assert.doesNotMatch(JSON.stringify(last?.entries ?? []), /Echo: slow rows/);
		// A stopped run shows nothing; the main conversation still runs, and the session's item says so.
		await browser.wait(`!${row("helper")}.querySelector('.nav-marker > *')`);
		assert.ok(status.statuses.value?.[session]?.busy.includes(1), "the main conversation still runs");
		assert.ok(
			await browser.evaluate<boolean>(
				`Boolean(${row("helper")}.closest('.session-row').querySelector('.session-header .nav-marker > .pi-dots'))`,
			),
		);
		// The failed one keeps its failure while the other one works and stops.
		assert.equal((await shown("failing")).status, `failed: ${failure}`);
		await main.stop(BACKGROUND_CONTEXT);
		await until(status.statuses, (states) => states?.[session]?.busy.length === 0);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 700 });
		for (const held of [sub, main, status]) held.release();
	});

	it("cuts a long name with an ellipsis and keeps each age whole on its name's baseline, on a phone (no action button) and in RTL", async () => {
		const title = "A session title long enough to be cut at every sidebar width";
		await (await holdWith(fixture.browser(), Sessions, {}, ...SESSIONS_OWNER)).rename(
			{ id: session, title },
			BACKGROUND_CONTEXT,
		);
		const item = `${row("failing")}.closest('.session-row')`;
		const check = async (where: string) => {
			await browser.wait(
				`${item}.querySelector('.session-header .session-title').textContent === ${JSON.stringify(title)}`,
			);
			for (const dir of ["ltr", "rtl"]) {
				await browser.evaluate(`document.documentElement.dir=${JSON.stringify(dir)}`);
				const offsets = await browser.evaluate<BaselineOffset[]>(
					baselineOffsets(
						`[${item}.querySelector('.session-header'), ...${item}.querySelectorAll('.conversation-row')]`,
					),
				);
				assert.deepEqual(
					offsets.map((each) => [each.kind, each.end]),
					[
						["session", "now"],
						["subagent", "now"],
						["subagent", "now"],
					],
				);
				for (const { label, end, offset } of offsets)
					assert(Math.abs(offset) < 0.5, `${label}'s "${end}" is ${offset}px off its baseline (${where}, ${dir})`);
				assert.deepEqual(
					await browser.evaluate<unknown>(
						`(() => { const header = ${item}.querySelector('.session-header'); const t = header.querySelector('.nav-label'), a = header.querySelector('.item-age'); return [getComputedStyle(t).textOverflow, t.scrollWidth > t.clientWidth, a.scrollWidth <= a.clientWidth]; })()`,
					),
					["ellipsis", true, true],
					`the title is cut, the age whole (${where}, ${dir})`,
				);
			}
			await browser.evaluate(`document.documentElement.removeAttribute('dir')`);
		};
		await check("desktop");
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.click(".topbar button[aria-label=Sessions]");
		await browser.wait(`document.querySelector('.app.drawer-open')`);
		const toggle = `document.querySelector('.sidebar-section[data-key=other] .session-header.has-subagents .subagent-toggle')`;
		await browser.wait(toggle);
		if ((await browser.evaluate<string>(`${toggle}.getAttribute('aria-expanded')`)) === "false")
			await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`${row("helper")} && ${row("failing")}`);
		await check("phone");
		// On touch screens the item's command menu has its action (a long press): no button.
		assert.equal(
			await browser.evaluate<string>(`getComputedStyle(${row("helper")}.querySelector('.item-action')).display`),
			"none",
		);
		await browser.evaluate("history.back()");
		await browser.wait(`!document.querySelector('.app.drawer-open')`);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		await browser.metrics(1280, 800);
	});

	it('archives an idle subagent from its item: it moves under "1 archived"', async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`${row("helper")}`);
		await browser.evaluate(`${row("helper")}.closest('.session-row').querySelector('.subagent-toggle').click()`);
		await browser.wait(`${row("helper")}.getClientRects().length > 0`);
		await hover("helper");
		await browser.click(
			`.sidebar-section[data-key=other] .conversation-row > button.item-action[data-action=archive][aria-label="Archive helper"]`,
		);
		await browser.wait(
			`document.querySelector('.sidebar-section[data-key=other] .subagent-stored .session-title')?.textContent === '1 archived'`,
		);
		// Behind the closed "1 archived" row: the shown list has the failing one only.
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.sidebar-section[data-key=other] a.subagent-row:not(.subagent-stored)')].filter(e=>!e.closest('[hidden]')).map(e=>e.querySelector('.session-title').textContent)`,
			),
			["failing"],
		);
		const agents = await holdWith(fixture.browser(), Subagents, {}, "children");
		await until(
			agents.children,
			(value) => value?.[session]?.find((child) => child.name === "helper")?.archived === true,
		);
		agents.release();
	});
});
