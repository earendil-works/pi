// A session's subagent rows in the sidebar, in Chromium, end to end: while a subagent works its row ends with its
// step, once stopped with "Stopped", after a provider error with "Failed" (its tooltip says why), and idle with the
// time since its newest message, in the session's time column; each row's tooltip names its model and where it works.
// The fake provider answers; a local provider that refuses every request (HTTP 400) makes one subagent fail.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { type Child, Subagents } from "../../plugins/subagents/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";
import { type BaselineOffset, baselineOffsets } from "./sidebar-baselines.ts";

/** What a subagent's row shows: its end's text, its failure mark's title, and the row's tooltip. */
type Shown = { end: string; mark: string | null; tooltip: string };

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
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace, title: "Subagent rows" }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const agents = await holdIn(owner, Subagents, {}, "reader");
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
		const toggle = `document.querySelector('.sidebar-section[data-key=recent] .session-header.has-subagents .subagent-toggle')`;
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
		`[...document.querySelectorAll('.sidebar-section[data-key=recent] .nav-row:has(> .subagent-row)')].find(e=>e.querySelector('.session-title').textContent===${JSON.stringify(name)})`;
	const shown = (name: string) =>
		browser.evaluate<Shown>(
			`(() => { const e = ${row(name)}; return { end: e.querySelector('.nav-details')?.textContent ?? '', mark: e.querySelector('.failed-mark')?.title ?? null, tooltip: e.querySelector('.subagent-row').title }; })()`,
		);
	const helper = () => children.find((child) => child.name === "helper")!;

	it("shows an idle subagent's time in its session's time column, and its model and location as its tooltip", async () => {
		await browser.wait(`${row("helper")}.querySelector('.session-time')?.textContent === 'now'`);
		assert.deepEqual(await shown("helper"), { end: "now", mark: null, tooltip: "faux-1 · off\nFollows the session" });
		const edges = await browser.evaluate<number[]>(
			`[${row("helper")}.closest('.session-row').querySelector('.session-header .session-time'), ${row("helper")}.querySelector('.session-time')].map(e=>Math.round(e.getBoundingClientRect().right))`,
		);
		assert.equal(edges[0], edges[1], "the subagent's time ends where the session's does");
		// The subagents are a list one level below the session: no tree guides (those are the branches').
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...${row("helper")}.closest('.conversation-items').querySelectorAll('.conversation-row')].map(e=>getComputedStyle(e).getPropertyValue('--depth')+':'+[...e.querySelectorAll(':scope > .tree-guide')].map(g=>g.dataset.guide+g.style.getPropertyValue('--level')).join(' '))`,
			),
			["1:", "1:"],
		);
	});

	it("shows a provider error as Failed, its text in the tooltip", async () => {
		assert.deepEqual(await shown("failing"), {
			end: "Failed",
			mark: '400: {"message":"fixture bad request","type":"invalid_request_error"}',
			tooltip:
				'm1 · off\nFollows the session\nFailed: 400: {"message":"fixture bad request","type":"invalid_request_error"}',
		});
	});

	it("shows the step while a subagent works, then Stopped once its run is stopped", async () => {
		const sub = await holdIn(
			fixture.browser(),
			Chat,
			{ session, conversation: helper().conversationId },
			"participant",
		);
		// Idle its marker is a ring; working, the spinner in the same box of its row (which may move up), so the mark
		// does not move: the same centre and layout size (a turning spinner's bounds are wider).
		const mark = (selector: string) =>
			browser.evaluate<string>(
				`(() => { const e = ${row("helper")}; const o = e.getBoundingClientRect(); const m = e.querySelector('.nav-marker ${selector}'); const r = m.getBoundingClientRect(); return [(r.left + r.right) / 2 - o.left, (r.top + r.bottom) / 2 - o.top, m.offsetWidth, m.offsetHeight].join(); })()`,
			);
		const ring = await mark(".run-mark[data-state=idle]");
		assert.deepEqual(
			await browser.evaluate<unknown>(
				`(() => { const m = ${row("helper")}.querySelector('.nav-marker > .run-mark'); return [m.dataset.state, m.getAttribute('aria-hidden'), m.getAttribute('role')]; })()`,
			),
			["idle", "true", null],
		);
		await sub.send({ text: "slow rows", requestId: "slow" }, BACKGROUND_CONTEXT);
		await browser.wait(`${row("helper")}.querySelector('.subagent-step')?.textContent === 'Thinking'`);
		assert.equal(await mark(".run-mark[data-state=working]"), ring);
		assert.equal(
			await browser.evaluate<boolean>(`${row("helper")}.querySelector('.run-mark[data-state=idle]') === null`),
			true,
		);
		// One mark in both states: the idle ring is decoration (the row's end says the state), the spinner says "Working".
		assert.deepEqual(
			await browser.evaluate<unknown>(
				`(() => { const m = ${row("helper")}.querySelectorAll('.nav-marker > .run-mark'); return [m.length, m[0].getAttribute('role'), m[0].getAttribute('aria-label'), m[0].title]; })()`,
			),
			[1, "img", "Working", "Working"],
		);
		assert.equal((await shown("helper")).tooltip, "faux-1 · off\nFollows the session");
		await sub.stop(BACKGROUND_CONTEXT);
		await browser.wait(`${row("helper")}.querySelector('.subagent-step')?.textContent === 'Stopped'`);
		assert.deepEqual(await shown("helper"), {
			end: "Stopped",
			mark: null,
			tooltip: "faux-1 · off\nFollows the session",
		});
		// The failed one keeps its failure while the other one works and stops.
		assert.equal((await shown("failing")).end, "Failed");
		sub.release();
	});

	it("keeps each end text on its label's baseline, the warning sign centred on its word, on a phone and in RTL", async () => {
		const item = `${row("failing")}.closest('.session-row')`;
		const check = async (where: string) => {
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
						["subagent", "Stopped"],
						["subagent", "Failed"],
					],
				);
				for (const { label, end, offset } of offsets)
					assert(Math.abs(offset) < 0.5, `${label}'s "${end}" is ${offset}px off its baseline (${where}, ${dir})`);
				// The warning sign's centre on its word's (the word's line box, wrapped for the measure).
				const apart = await browser.evaluate<number>(
					`(() => { const m = ${row("failing")}.querySelector('.failed-mark'); const text = [...m.childNodes].find((n) => n.nodeType === 3); const wrap = document.createElement('span'); text.replaceWith(wrap); wrap.append(text); const w = wrap.getBoundingClientRect(); wrap.replaceWith(text); const i = m.querySelector('svg').getBoundingClientRect(); return (i.top + i.bottom) / 2 - (w.top + w.bottom) / 2; })()`,
				);
				assert(Math.abs(apart) < 1, `the warning sign is ${apart}px off its word (${where}, ${dir})`);
			}
			await browser.evaluate(`document.documentElement.removeAttribute('dir')`);
		};
		await check("desktop");
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.click(".topbar button[aria-label=Sessions]");
		await browser.wait(`document.querySelector('.app.drawer-open')`);
		const toggle = `document.querySelector('.sidebar-section[data-key=recent] .session-header.has-subagents .subagent-toggle')`;
		await browser.wait(toggle);
		if ((await browser.evaluate<string>(`${toggle}.getAttribute('aria-expanded')`)) === "false")
			await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`${row("helper")} && ${row("failing")}`);
		await check("phone");
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		await browser.metrics(1280, 800);
	});
});
