// A transcript in a hidden pane must not measure its rows as zero high there. It did, and each commit's measurement
// moved the rendered range again until React gave up (minified error #185, "Maximum update depth exceeded"), right
// after an artifact was opened. The chat's pane is hidden on a phone and in a narrow desktop window (one pane at a time:
// the opened view takes it), and in a wide window when a view is the front tab of the chat's area (the agent's
// arrangement, or the person's). Showing the chat again lays the rows out where they were. Fake provider, a disposable
// session.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat, type ChatParticipant } from "../../plugins/chat/contract.ts";
import { SESSIONS_OWNER, Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdWith, startFixture, until } from "./helpers.ts";

/**
 * Turns in the conversation, each a tall message (many short lines: few tokens) and its echo: the rows' estimated
 * heights add up to far more than 50 renders' worth of rows (a viewport and its overscan each).
 */
const TURNS = 100;
const message = (turn: number) => `message ${turn}\n${"a line\n".repeat(100)}`;

/**
 * Records what the page reports as its errors (`/client-error`, src/web/app-boundary.tsx), except Chromium's
 * "ResizeObserver loop completed with undelivered notifications" (the notifications come the next frame; loading the
 * history in a desktop-size window raises it, also before this change).
 */
const CLIENT_ERRORS = `(() => {
	window.p2ClientErrors = [];
	const original = window.fetch;
	window.fetch = (input, init) => {
		if (String(input).endsWith("/client-error")) {
			const message = JSON.parse(init.body).message;
			if (!message.startsWith("ResizeObserver loop")) window.p2ClientErrors.push(message);
		}
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
	let chat: ChatParticipant;

	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "notes.md"), "# Plan\n\nThe artifact the agent opened.\n");
		const owner = fixture.browser();
		const sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		session = (await sessions.create({ cwd: fixture.workspace, title: "Long" }, BACKGROUND_CONTEXT)).id;
		chat = await holdWith(owner, Chat, { session, conversation: 1 }, ...CHAT_PARTICIPANT);
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

	/** Runs `code` in code mode as the agent and waits for its turn to end. */
	const agent = async (code: string, requestId: string) => {
		await chat.send({ text: `codemode ${code}`, requestId }, BACKGROUND_CONTEXT);
		await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run);
	};
	const shownPanes = "[...document.querySelectorAll('.views-pane:not([hidden])')].map(p=>p.dataset.viewPane).join()";

	/**
	 * The page at `width`×`height` with the whole history loaded and following the newest message; `hide` makes the
	 * agent hide the chat's pane behind view `view`, `showChat` brings the chat back. Neither may loop React, the hidden
	 * transcript keeps the rows it rendered, and the chat comes back laid out at its end.
	 */
	const hideAndShow = async (
		{ width, height, mobile }: { width: number; height: number; mobile: boolean },
		view: string,
		hide: () => Promise<void>,
		showChat: () => Promise<void>,
	) => {
		await browser.call("Emulation.setDeviceMetricsOverride", { width, height, mobile, deviceScaleFactor: 1 });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: message ${TURNS}')`);
		// The reader scrolled back through the whole history: every row is loaded.
		for (let page = 0; page < 40; page++) {
			const loaded = await browser.evaluate<string>("document.querySelector('.messages .rows')?.dataset.rows");
			await browser.evaluate("document.querySelector('[data-view-pane=transcript] .scroller').scrollTop = 0");
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
		await hide();
		await browser.wait(`${shownPanes}===${JSON.stringify(view)}`).catch(async (error: unknown) => {
			// A page that broke says why.
			assert.deepEqual(await browser.evaluate<string[]>("window.p2ClientErrors"), []);
			throw error;
		});
		await browser.wait(
			`document.querySelector('[data-view-pane=${JSON.stringify(view)}]')?.textContent.includes('The artifact the agent opened')`,
		);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.deepEqual(await browser.evaluate<string[]>("window.p2ClientErrors"), []);
		// Hidden, it keeps the rows it rendered: not every loaded row.
		assert.ok((await browser.evaluate<number>("document.querySelectorAll('.messages [data-row]').length")) < 60);
		// Back to the chat: its rows are laid out, the newest at the bottom of the transcript.
		await showChat();
		await browser.wait(`${shownPanes}.split(',').includes('transcript')`);
		await browser.wait(
			`(() => { const rows = [...document.querySelectorAll('.messages [data-row]')]; return rows.length > 0 && rows.every((row) => row.getBoundingClientRect().height > 0); })()`,
		);
		await browser.wait(
			`(() => { const s = document.querySelector('[data-view-pane=transcript] .scroller'); return s && s.scrollHeight - s.clientHeight - s.scrollTop < 2; })()`,
		);
		assert.deepEqual(await browser.evaluate<string[]>("window.p2ClientErrors"), []);
	};
	/** The agent opens view `id` of notes.md. */
	const open = (id: string) =>
		agent(`await tools.view_open({ kind: "markdown", title: "Plan ${id}", item: "notes.md", id: "${id}" });`, id);
	/** The phone's (and a narrow window's) strip shows the chat again. */
	const phoneChat = () =>
		browser.evaluate<void>(
			`[...document.querySelectorAll('.views-tabs.phone .views-tab')].find(t=>t.textContent==='Chat').click()`,
		);

	it("on a phone: the opened view takes the screen", async () => {
		await hideAndShow({ width: 390, height: 844, mobile: true }, "phone", () => open("phone"), phoneChat);
	});

	it("in a narrow desktop window: one pane at a time, as on a phone", async () => {
		await hideAndShow({ width: 600, height: 900, mobile: false }, "narrow", () => open("narrow"), phoneChat);
	});

	it("in a wide desktop window: the agent arranges the view as a tab in front of the chat", async () => {
		await hideAndShow(
			{ width: 1440, height: 900, mobile: false },
			"wide",
			async () => {
				await open("wide");
				await agent(
					`await tools.view_arrange({ layout: { tabs: ["transcript", "wide"], active: "wide" } });`,
					"arrange",
				);
			},
			async () => {
				const tab = `[...document.querySelectorAll('.views-tab')].find(t=>t.textContent==='Chat')`;
				const centre = await browser.evaluate<{ x: number; y: number }>(
					`(() => { const r = ${tab}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
				);
				await browser.clickPoint(centre.x, centre.y);
			},
		);
	});
});
