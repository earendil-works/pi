// Browser checks of the "wrong behavior" fixes from the Pi Mobile parity audit: entries kept as they leave the view's
// window and autoloaded earlier pages, the composer while the chat is not live, subagent search hits, the
// ports card, the Stop notice per conversation and composer focus after a restore. Fake provider, disposable data.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryDraft, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { ForwardsNative } from "../../plugins/ports/contract.ts";
import { Sessions, SessionTransfer } from "../../plugins/sessions/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { bigSessionEntries } from "../fixtures/big-session.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const answered = (text: string) => (view: ConversationView | null | undefined) =>
	JSON.stringify(view?.entries ?? []).includes(text) && !live(view)?.run;
const input = (selector: string, value: string) =>
	`(() => { const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true})); })()`;
const messages = "(document.querySelector('.messages')?.textContent ?? '')";
/** The texts of the people's messages shown (a compaction summary may quote old answers; bubbles are exact). */
const bubbles = "[...document.querySelectorAll('.messages .user .bubble')].map((e) => e.textContent.trim())";
const shows = (text: string) => `${bubbles}.some((t) => t.endsWith(${JSON.stringify(text)}))`;
/**
 * Which of the test's messages the whole transcript shows, sorted: it renders only the rows near the viewport, so this scrolls
 * from the top to the bottom in half viewports and collects what each position shows.
 */
const SEEN = `(async () => {
	const scroller = document.querySelector('.scroller');
	const seen = new Set();
	const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	scroller.scrollTop = 0;
	await frame();
	for (let step = 0; step < 200; step++) {
		for (const text of ['one', 'two', 'slow three', 'four']) if (${bubbles}.some((t) => t.endsWith(text))) seen.add(text);
		if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2) break;
		scroller.scrollTop += scroller.clientHeight / 2;
		await frame();
	}
	return [...seen].sort();
})()`;
/** Scrolls the transcript to its top (true), as often as polled. */
const toTop = "(() => { document.querySelector('.scroller').scrollTop = 0; return true; })()";
/** How far the transcript is from its top. */
const FROM_START = "document.querySelector('.scroller').scrollTop";
/** Whether the transcript is scrolled to its top. */
const atTop = "document.querySelector('.scroller').scrollTop < 2";

describe("Pi Mobile audit fixes in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	const url = (path: string) => `http://127.0.0.1:${fixture.server.port}${path}`;

	before(async () => {
		fixture = await startFixture({ web: true });
		owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("autoloads earlier pages on scroll-up and keeps entries that leave the window", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Long",
			},
			BACKGROUND_CONTEXT,
		);
		// More entries than the window holds: the first ones load as earlier pages.
		await fixture.server.host.root(
			async (ctx) =>
				(await ctx.get(SessionTransfer, { session: session.id })).seed(
					{ entries: bigSessionEntries(120, 500) },
					ctx,
				),
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await browser.metrics(390, 844);
			await browser.open(url(`/s/${session.id}`));
			await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
			for (const text of ["one", "two", "slow three"]) {
				await chat.send({ text, requestId: text }, BACKGROUND_CONTEXT);
				await until(chat.view, answered(`Echo: ${text}`), 30_000);
			}
			assert.ok(chat.view.value?.before !== undefined, "the window starts after the first entries");
			// The watching page shows every turn.
			assert.deepEqual(await browser.evaluate<string[]>(SEEN), ["one", "slow three", "two"]);

			// A fresh page starts from the window; scrolling up loads earlier pages without a click.
			await browser.open(url(`/s/${session.id}`));
			// It opens at the bottom, on the last answer.
			await browser.wait(`${messages}.includes('Echo: slow three')`);
			await browser.wait(
				`(() => { const e=document.querySelector('.scroller');return e.scrollHeight > e.clientHeight * 1.5; })()`,
			);
			// The reader scrolls to the top (a native scroll event, as a swipe or the wheel causes); each earlier page
			// arrives above the reader's place, so they scroll up again.
			await browser.wait(`${toTop} && ${shows("module 1 and fix what is broken.")}`);
			await browser.wait(`!document.querySelector('.earlier')`);

			// Turns follow until the window has dropped the first message: the page keeps it.
			const inWindow = () =>
				chat.view.value?.entries.some((entry) => (entry.data as { text?: unknown } | undefined)?.text === "one");
			for (let turn = 0; turn < 40 && inWindow(); turn++) {
				await chat.send({ text: `${turn} four`, requestId: `four-${turn}` }, BACKGROUND_CONTEXT);
				await until(chat.view, answered(`Echo: ${turn} four`), 30_000);
			}
			assert.ok(!inWindow(), "the window moved past the first message");
			assert.deepEqual(await browser.evaluate<string[]>(SEEN), ["four", "one", "slow three", "two"]);
		} finally {
			stop();
			chat.release();
		}
	});

	it("loads earlier pages by itself while a turn's many tool calls, one row, leave nothing to scroll", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace, title: "One long turn" },
			BACKGROUND_CONTEXT,
		);
		// A few turns, then one with more tool calls than the window and a page hold: they are all one activity row.
		const entries = bigSessionEntries(20);
		const text = "Run every check";
		entries.push({
			kind: "p2.input",
			data: { author: { kind: "owner", id: "owner", name: "Owner" }, text, attachments: [] },
			model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1_800_000_000_000 }],
		} as EntryDraft);
		for (let call = 0; call < 150; call++) {
			const id = `check-${call}`;
			entries.push(
				{
					kind: "pi.assistant",
					model: [
						{
							...fauxAssistantMessage([]),
							content: [{ type: "toolCall", id, name: "bash", arguments: { command: `check ${call}` } }],
							stopReason: "toolUse",
							timestamp: 1_800_000_000_001 + call,
						},
					],
				} as EntryDraft,
				{
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: id,
							toolName: "bash",
							content: [{ type: "text", text: "ok" }],
							isError: false,
							timestamp: 1_800_000_000_001 + call,
						},
					],
				} as EntryDraft,
			);
		}
		entries.push({
			kind: "pi.assistant",
			model: [
				{
					...fauxAssistantMessage([]),
					content: [{ type: "text", text: "All checks pass." }],
					timestamp: 1_800_000_001_000,
				},
			],
		} as EntryDraft);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(SessionTransfer, { session: session.id })).seed({ entries }, ctx),
			BACKGROUND_CONTEXT,
		);
		await browser.metrics(390, 844);
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`${messages}.includes('All checks pass.')`);
		// Without a scroll, the pages before the long turn arrive: its message, and earlier turns above to scroll back to.
		await browser.wait(`${shows(text)} || ${messages}.includes('Please look at module')`);
		await browser.wait(
			`(() => { const e=document.querySelector('.scroller');return e.scrollHeight > e.clientHeight * 1.5; })()`,
		);
		assert.equal(await browser.evaluate("document.querySelectorAll('[data-testid=activity]').length > 1"), true);
	});

	it("keeps the composer and Send while the chat object restarts; a message sent meanwhile arrives", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Cold",
			},
			BACKGROUND_CONTEXT,
		);
		await browser.metrics(1280, 900);
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea') && document.querySelector('.hero.small-hero')`);
		await browser.evaluate(input(".composer textarea", "typed while loading"));
		await browser.wait(`!document.querySelector('.composer button[aria-label=Send]').disabled`);
		// Stopping the worker makes the page's Chat handle gone; it is acquired again while the worker starts.
		await browser.evaluate(
			`(() => { window.__samples = []; window.__timer = setInterval(() => window.__samples.push({ composer: !!document.querySelector('.composer textarea'), typed: document.querySelector('.composer textarea')?.value.trim() !== '', send: document.querySelector('.composer button[aria-label=Send]')?.disabled ?? null, connecting: [...document.querySelectorAll('.subagent-bar')].some((e) => e.textContent.includes('Connecting')) }), 20); })()`,
		);
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		try {
			await hosts.stop({ session: session.id }, BACKGROUND_CONTEXT);
		} finally {
			hosts.release();
		}
		// Sending does not wait for the chat object (plugins/chat/outbox.ts): the message shows at once and is
		// delivered once the worker is back.
		assert.equal(await browser.evaluate(`document.querySelector('.composer textarea').value`), "typed while loading");
		await browser.click("button[aria-label=Send]");
		await browser.wait(`document.querySelector('.composer textarea').value === ''`);
		await browser.wait(`${messages}.includes('Echo: typed while loading')`);
		const samples = await browser.evaluate<
			{ composer: boolean; typed: boolean; send: boolean | null; connecting: boolean }[]
		>(`(() => { clearInterval(window.__timer); return window.__samples; })()`);
		assert.ok(samples.length > 5);
		assert.ok(
			samples.every((sample) => sample.composer && !sample.connecting),
			"the composer never left",
		);
		assert.ok(
			// With text in the composer; an empty one has nothing to send.
			samples.every((sample) => !sample.typed || sample.send !== true),
			"Send never waited",
		);
		assert.equal(
			await browser.evaluate<number>(`${bubbles}.filter((text) => text.endsWith('typed while loading')).length`),
			1,
		);
	});

	it("opens a subagent's search hit in its own conversation", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "With helper",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const list = await holdIn(owner, Subagents, {}, "reader");
		await chat.send({ text: "subagent", requestId: "spawn" }, BACKGROUND_CONTEXT);
		const children = await until(list.children, (value) => Boolean(value?.[session.id]?.length));
		const helper = children![session.id]![0]!;
		const child = await holdIn(
			owner,
			Chat,
			{ session: session.id, conversation: helper.conversationId },
			"participant",
		);
		await child.send({ text: "zebrafish unique words", requestId: "direct" }, BACKGROUND_CONTEXT);
		await until(child.view, answered("Echo: zebrafish unique words"), 30_000);
		await browser.metrics(1280, 900);
		await browser.open(url("/"));
		const search = 'input[aria-label="Search sessions and messages"]';
		await browser.wait(`document.querySelector('${search}') && !document.querySelector('.offline')`);
		await browser.evaluate(input(search, "zebrafish"));
		await browser.wait(`document.querySelector('.hit')?.textContent.includes('zebrafish')`);
		await browser.click(".hit");
		await browser.wait(
			`location.pathname === '/s/${session.id}/c/${helper.conversationId}' && ${messages}.includes('zebrafish unique words')`,
		);
		await browser.evaluate(input(search, ""));
		child.release();
		list.release();
		chat.release();
	});

	it("shows the ports card with its links", async () => {
		const store = (await fixture.server.host.registry(ForwardsNative, BACKGROUND_CONTEXT)).value!.forwards;
		store.radiusOrigin = "https://0123456789abcdef0123456789abcdef.rdtun.com";
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Ports",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send(
			{ text: 'ports {"action":"open","port":5173,"name":"web"}', requestId: "open" },
			BACKGROUND_CONTEXT,
		);
		await until(chat.view, answered("Forwarded port 5173"), 30_000);
		await browser.open(url(`/s/${session.id}`));
		// The opened port is a result for the person: its link after the answer.
		const anchor = "document.querySelector('[data-testid=results] a[data-testid=tool-link]')";
		await browser.wait(anchor);
		const link = await browser.evaluate<{ text: string; href: string }>(
			`(a => ({ text: a.textContent, href: a.href }))(${anchor})`,
		);
		assert.equal(link.text, "Open web");
		assert.match(link.href, /^https:\/\/fwd--0123456789abcdef0123456789abcdef--[a-z0-9]+\.rdtun\.com\/$/);
		await chat.send({ text: 'ports {"action":"close","port":5173}', requestId: "close" }, BACKGROUND_CONTEXT);
		await until(chat.view, answered("Stopped forwarding port 5173"), 30_000);
		chat.release();
	});

	it("clears the Stop notice in another conversation and focuses the composer after a restore", async () => {
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const first = await sessions.create({ cwd: fixture.workspace, title: "Stopped here" }, BACKGROUND_CONTEXT);
		const second = await sessions.create({ cwd: fixture.workspace, title: "Elsewhere" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: first.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await browser.metrics(1280, 900);
			await browser.open(url(`/s/${first.id}`));
			await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
			// A queued follow-up moved back to the editor lands there with the focus.
			await chat.send({ text: "slow running", requestId: "slow" }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => Boolean(live(view)?.run));
			await chat.send({ text: "queued words", requestId: "queued", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
			await browser.wait(`document.querySelector('.queue-edit')`);
			await browser.evaluate(`document.activeElement?.blur()`);
			await browser.click(".queue-edit");
			await browser.wait(
				`document.querySelector('.composer textarea').value.includes('queued words') && document.activeElement === document.querySelector('.composer textarea')`,
			);
			await browser.evaluate(input(".composer textarea", ""));
			await until(chat.view, answered("Echo: slow running"), 30_000);
			// Stopped during a tool call: no aborted answer, so the Stop notice shows.
			await chat.send({ text: "slow-tool", requestId: "tool" }, BACKGROUND_CONTEXT);
			await browser.wait(`document.querySelector('.composer button[aria-label=Stop]')`);
			await browser.click(".composer button[aria-label=Stop]");
			await browser.wait(`document.querySelector('output.notice.stopped')`);
			// Another conversation, then back: the notice belonged to that stop, not to every later visit.
			const row = (title: string) =>
				`[...document.querySelectorAll('.drawer .session-main')].find((e) => e.querySelector('.session-title')?.textContent === ${JSON.stringify(title)})`;
			await browser.evaluate(`${row("Elsewhere")}.click()`);
			await browser.wait(`location.pathname === '/s/${second.id}'`);
			await browser.evaluate(`${row("Stopped here")}.click()`);
			await browser.wait(`location.pathname === '/s/${first.id}' && ${messages}.includes('slow running')`);
			assert.equal(await browser.evaluate(`document.querySelector('output.notice.stopped') === null`), true);
		} finally {
			stop();
			chat.release();
		}
	});

	it("keeps the reader's scroll position after sending review comments from the workspace", async () => {
		const repo = join(fixture.workspace, "review-repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "hello.ts"), "export const answer = 41;\n");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-q");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "add", ".");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Initial");
		writeFileSync(join(repo, "hello.ts"), "export const answer = 42;\n");
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: repo, title: "Review" },
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await chat.send({ text: "slow long answer", requestId: "long" }, BACKGROUND_CONTEXT);
			await until(chat.view, answered("Echo: slow long answer"), 30_000);
			await browser.metrics(1280, 900);
			await browser.open(url(`/s/${session.id}`));
			await browser.wait(`${messages}.includes('Echo: slow long answer') && !document.querySelector('.offline')`);
			// The reader scrolls up once there is something to scroll (the dock's padding has settled): the chat stops
			// following.
			await browser.wait(`(e => e.scrollHeight > e.clientHeight + 100)(document.querySelector('.scroller'))`);
			await browser.evaluate(toTop);
			await browser.wait(`document.querySelector('.to-bottom')`);
			await browser.click('button[aria-label="Workspace files and changes"]');
			await browser.wait(
				`[...document.querySelectorAll('.workspace-name')].some((e) => e.textContent === 'hello.ts')`,
			);
			await browser.evaluate(
				`[...document.querySelectorAll('.workspace-row')].find((e) => e.querySelector('.workspace-name')?.textContent === 'hello.ts').classList.add('test-file')`,
			);
			await browser.click(".test-file");
			await browser.wait(`document.querySelector('.diff-line button.diff-number')`);
			await browser.click(".diff-line button.diff-number");
			await browser.wait(`document.querySelector('textarea[aria-label=Comment]')`);
			await browser.evaluate(input("textarea[aria-label=Comment]", "Why 42?"));
			await browser.evaluate(
				`[...document.querySelectorAll('.line-comment-actions button')].find((e) => e.textContent === 'Add comment').classList.add('test-add')`,
			);
			await browser.click(".test-add");
			await browser.wait(`document.querySelector('.review-bar')?.textContent.includes('1 comment')`);
			const rows = await browser.evaluate<number>(`Number(document.querySelector('.rows').dataset.rows)`);
			await browser.click(".review-bar .button.primary");
			await until(chat.view, answered("Echo: Review comments"), 30_000);
			// Sending keeps the reader where they were: no jump to the bottom, the scroll-down button stays. The comments
			// and their answer arrive below the reader (the transcript renders only the rows near the viewport).
			await browser.wait(`Number(document.querySelector('.rows').dataset.rows) >= ${rows + 2}`);
			assert.ok(await browser.evaluate<boolean>(atTop));
			assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.to-bottom'))`));
		} finally {
			stop();
			chat.release();
		}
	});

	it("keeps the reader's scroll position after Send", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Scroll",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await chat.send({ text: "slow long answer", requestId: "long-send" }, BACKGROUND_CONTEXT);
			await until(chat.view, answered("Echo: slow long answer"), 30_000);
			await browser.metrics(1280, 900);
			await browser.open(url(`/s/${session.id}`));
			await browser.wait(`${messages}.includes('Echo: slow long answer') && !document.querySelector('.offline')`);
			await browser.evaluate(toTop);
			await browser.wait(`document.querySelector('.to-bottom')`);
			await browser.evaluate(input(".composer textarea", "Next question"));
			const rows = await browser.evaluate<number>(`Number(document.querySelector('.rows').dataset.rows)`);
			await browser.click("button[aria-label=Send]");
			await until(chat.view, answered("Echo: Next question"), 30_000);
			// The question and its answer arrive below the reader (only the rows near the viewport are rendered).
			await browser.wait(`Number(document.querySelector('.rows').dataset.rows) >= ${rows + 2}`);
			assert.ok(
				await browser.evaluate<boolean>(atTop),
				`moved ${await browser.evaluate<number>(FROM_START)}px from the top`,
			);
			// A taller composer (a second line) keeps the reader's place too: its room is below them.
			await browser.evaluate(input(".composer textarea", "one\ntwo\nthree\nfour"));
			await browser.wait(`document.querySelector('.composer textarea').clientHeight > 60`);
			assert.ok(
				await browser.evaluate<boolean>(atTop),
				`moved ${await browser.evaluate<number>(FROM_START)}px from the top`,
			);
			await browser.evaluate(input(".composer textarea", ""));
			assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.to-bottom'))`));
		} finally {
			stop();
			chat.release();
		}
	});

	it("says why a session archived elsewhere closed, and titles the Envs button", async () => {
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create(
			{ cwd: fixture.workspace, title: "Archived elsewhere" },
			BACKGROUND_CONTEXT,
		);
		await browser.metrics(1280, 900);
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
		assert.equal(
			await browser.evaluate<string>(
				`[...document.querySelectorAll('.foot-button')].find((e) => e.textContent === 'Envs')?.title`,
			),
			"Remote environments",
		);
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		await browser.wait(
			`location.pathname === '/' && document.querySelector('.toast')?.textContent === 'Session is archived'`,
		);
	});

	it("archives the viewed session from its sheet without an error or a notice", async () => {
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "Archived here" }, BACKGROUND_CONTEXT);
		await browser.metrics(390, 844);
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
		// The page's conversation is live: its worker runs, and the page keeps holding it after leaving (linger).
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		await until(hosts.workers, (workers) => workers?.[session.id]?.running === true);
		await browser.click('[aria-label="Session options"]');
		await browser.click(".row-button.danger");
		await until(sessions.sessions, (list) => Boolean(list?.find((s) => s.id === session.id)?.archivedAt));
		await until(hosts.workers, (workers) => workers?.[session.id]?.running === false);
		// Leaving the session released the sheet's reference: the archive's call is not cancelled with it (no
		// "p2.sessions: released" toast), and the lingering conversation starts no worker the archive refuses (no notice).
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.deepEqual(
			await browser.evaluate(
				`({ path: location.pathname, toast: document.querySelector('.toast')?.textContent ?? null, notices: [...document.querySelectorAll('.owner-notice')].map((e) => e.textContent) })`,
			),
			{ path: "/", toast: null, notices: [] },
		);
		hosts.release();
	});

	it("sends with one tap on Send: the press keeps the composer focused, so a phone's keyboard does not close first", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace, title: "Tap send" },
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await browser.metrics(390, 844);
			await browser.open(url(`/s/${session.id}`));
			await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
			await browser.evaluate(`document.querySelector('.composer textarea').focus()`);
			await browser.call("Input.insertText", { text: "tap send" });
			await browser.wait(`!document.querySelector('.composer .send').disabled`);
			const [x, y] = await browser.evaluate<[number, number]>(
				`(() => { const r = document.querySelector('.composer .send').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
			);
			// Pressing Send leaves the focus in the textarea (blurring it would close a phone's keyboard and move the button).
			await browser.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
			assert.equal(
				await browser.evaluate<boolean>(`document.activeElement === document.querySelector('.composer textarea')`),
				true,
			);
			// Releasing it sends: one tap, no second press.
			await browser.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
			await until(chat.view, answered("Echo: tap send"), 30_000);
		} finally {
			stop();
			chat.release();
		}
	});

	it("sends with one touch tap beside Send while the keyboard composes a word; no tap in the composer blurs it", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace, title: "Touch send" },
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		const focused = `document.activeElement === document.querySelector('.composer textarea')`;
		const tap = async (x: number, y: number) => {
			await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
			await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		};
		try {
			await browser.metrics(390, 844);
			await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
			await browser.open(url(`/s/${session.id}`));
			await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
			await browser.evaluate(`document.querySelector('.composer textarea').focus()`);
			// A phone's keyboard holds the word being typed as a composition until it is committed.
			await browser.call("Input.insertText", { text: "touch " });
			await browser.call("Input.imeSetComposition", { text: "send", selectionStart: 4, selectionEnd: 4 });
			await browser.wait(`!document.querySelector('.composer .send').disabled`);
			const [bar, right, middle] = await browser.evaluate<[number, number, number]>(
				`(() => { const s = document.querySelector('.composer .send').getBoundingClientRect(), f = document.querySelector('.composer').getBoundingClientRect(); return [s.left - 30, f.right - 6, s.top + s.height / 2]; })()`,
			);
			// A tap in the bar's gap left of Send does nothing: the textarea keeps the focus (and a phone its keyboard).
			await tap(bar, middle);
			assert.equal(await browser.evaluate<boolean>(focused), true);
			// A tap right of Send's glyph, in the composer's padding where a thumb aiming at it lands, sends at once.
			await tap(right, middle);
			await until(chat.view, answered("Echo: touch send"), 30_000);
			assert.deepEqual(
				await browser.evaluate<[boolean, string]>(
					`[${focused}, document.querySelector('.composer textarea').value]`,
				),
				[true, ""],
			);
		} finally {
			await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
			stop();
			chat.release();
		}
	});

	it("keeps the caret where the user types inside the draft (the composer renders the draft it was given at once)", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace, title: "Caret" },
			BACKGROUND_CONTEXT,
		);
		await browser.metrics(390, 844);
		await browser.open(url(`/s/${session.id}`));
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
		await browser.evaluate(`document.querySelector('.composer textarea').focus()`);
		await browser.call("Input.insertText", { text: "hello world" });
		await browser.wait(`document.querySelector('.composer textarea').value === 'hello world'`);
		// Put the caret after "hello" and type there, one character at a time as a keyboard does.
		await browser.evaluate(`document.querySelector('.composer textarea').setSelectionRange(5, 5)`);
		for (const character of " there") await browser.call("Input.insertText", { text: character });
		assert.deepEqual(
			await browser.evaluate<[string, number]>(
				`(() => { const t = document.querySelector('.composer textarea'); return [t.value, t.selectionStart]; })()`,
			),
			["hello there world", 11],
		);
	});
});
