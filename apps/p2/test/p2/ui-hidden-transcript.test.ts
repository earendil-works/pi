// A transcript in a hidden pane (a phone shows one pane at a time: opening a view hides the chat): a long conversation
// must not measure its rows as zero high there. It did, and each commit's measurement moved the rendered range again
// until React gave up (minified error #185, "Maximum update depth exceeded"), right after an artifact was opened.
// Showing the chat again lays the rows out where they were. Fake provider, a disposable session.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/**
 * Turns in the conversation, each a tall message (many short lines: few tokens) and its echo: the rows' estimated
 * heights add up to far more than 50 renders' worth of rows (a viewport and its overscan each).
 */
const TURNS = 100;
const message = (turn: number) => `message ${turn}\n${"a line\n".repeat(100)}`;

/** Records what the page reports as its errors (`/client-error`, src/web/app-boundary.tsx). */
const CLIENT_ERRORS = `(() => {
	window.p2ClientErrors = [];
	const original = window.fetch;
	window.fetch = (input, init) => {
		if (String(input).endsWith("/client-error")) window.p2ClientErrors.push(JSON.parse(init.body).message);
		return original(input, init);
	};
})();`;

/** Whether the conversation's view (its newest entries) ends with an answer saying `text`, its turn over. */
const answered = (value: ConversationView | null | undefined, text: string) =>
	!(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run &&
	JSON.stringify(value?.entries.at(-1) ?? null).includes(text);

describe("a transcript in a hidden pane", { skip: !browserTests, timeout: 180_000 }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;

	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "notes.md"), "# Plan\n\nThe artifact the agent opened.\n");
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace, title: "Long" }, BACKGROUND_CONTEXT)).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		for (let turn = 1; turn <= TURNS; turn++) {
			await chat.send({ text: message(turn), requestId: `turn-${turn}` }, BACKGROUND_CONTEXT);
			await until(chat.view, (value) => answered(value, `Echo: message ${turn}`));
		}
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: CLIENT_ERRORS });
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("opens a view over a long transcript on a phone without an update loop, and shows the transcript again", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: message ${TURNS}')`);
		// The reader scrolled back through the whole history: every row is loaded.
		for (let page = 0; page < 40; page++) {
			const loaded = await browser.evaluate<string>("document.querySelector('.messages .rows')?.dataset.rows");
			await browser.evaluate("document.querySelector('.scroller').scrollTop = 0");
			await new Promise((resolve) => setTimeout(resolve, 300));
			if (
				(await browser.evaluate<string>("document.querySelector('.messages .rows')?.dataset.rows")) === loaded &&
				page > 3
			)
				break;
		}
		// And back to the newest message, following the answer again.
		await browser.wait("document.querySelector('.to-bottom')");
		await browser.click(".to-bottom");
		await browser.wait("!document.querySelector('.to-bottom')");
		// The agent opens a view: the phone shows it, the chat's pane is hidden.
		await chat.send(
			{
				text: `codemode await tools.view_open({ kind: "markdown", title: "Plan", item: "notes.md", id: "plan" });`,
				requestId: "open-view",
			},
			BACKGROUND_CONTEXT,
		);
		await browser
			.wait(`[...document.querySelectorAll('.views-pane:not([hidden])')].map(p=>p.dataset.viewPane).join()==='plan'`)
			.catch(async (error: unknown) => {
				// A page that broke says why.
				assert.deepEqual(await browser.evaluate<string[]>("window.p2ClientErrors"), []);
				throw error;
			});
		await browser.wait(
			`document.querySelector('[data-view-pane="plan"]')?.textContent.includes('The artifact the agent opened')`,
		);
		// The hidden transcript takes in the rest of the agent's turn meanwhile.
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.deepEqual(await browser.evaluate<string[]>("window.p2ClientErrors"), []);
		// Hidden, it keeps the rows it rendered: not every loaded row.
		assert.ok((await browser.evaluate<number>("document.querySelectorAll('.messages [data-row]').length")) < 60);
		// Back to the chat: its rows are laid out, the newest at the bottom of the transcript.
		await browser.evaluate(
			`[...document.querySelectorAll('.views-tabs.phone .views-tab')].find(t=>t.textContent==='Chat').click()`,
		);
		await browser.wait(
			`[...document.querySelectorAll('.views-pane:not([hidden])')].map(p=>p.dataset.viewPane).join()==='transcript'`,
		);
		await browser.wait(
			`(() => { const rows = [...document.querySelectorAll('.messages [data-row]')]; return rows.length > 0 && rows.every((row) => row.getBoundingClientRect().height > 0); })()`,
		);
		await browser.wait(
			`(() => { const s = document.querySelector('.scroller.transcript, .scroller'); return s && s.scrollHeight - s.clientHeight - s.scrollTop < 2; })()`,
		);
		assert.deepEqual(await browser.evaluate<string[]>("window.p2ClientErrors"), []);
	});
});
