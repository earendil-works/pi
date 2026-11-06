// settings.json's `detail` in the browser: how much of a turn the transcript shows, changed live. The fake model's
// script turn is a text, the script's call, thinking and the answer.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
/** The kinds of the transcript's rows after the person's message: "text", "activity", "thought", "answer". */
const ROWS = `[...document.querySelectorAll('.row')].slice(1).map((row) =>
	row.querySelector('[data-testid=activity]') ? 'activity' : row.querySelector('[data-testid=thought]') ? 'thought'
	: row.querySelector('.message-actions') ? 'answer' : 'text').join()`;

describe("detail in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, session: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Detail" }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send({ text: "codemode return 1;", requestId: "script" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => !live(view)?.run && JSON.stringify(view).includes("Echo: codemode"), 30_000);
		chat.release();
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("shows more of a turn from detail 1 to 4, live as settings.json changes", async () => {
		const settings = join(fixture.dataDir, "settings.json");
		const base = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
		const set = (detail: number) => writeFileSync(settings, JSON.stringify({ ...base, detail }));
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		// 2, the default: the text in the transcript, the call and the thinking on the wheel after it.
		await browser.wait(`${ROWS} === 'text,activity,answer'`);
		// 3: the text, the script's wheel, the thinking collapsed, the answer.
		set(3);
		await browser.wait(`${ROWS} === 'text,activity,thought,answer'`);
		// 1: only the answer; the text, the call and the thinking on one wheel, listed in its sheet.
		set(1);
		await browser.wait(`${ROWS} === 'activity,answer'`);
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelectorAll('[data-testid=activity-sheet] [data-testid=step]').length === 3");
		assert.equal(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=activity-sheet] [data-testid=step]')].map((e) => e.dataset.kind ?? 'call').join()",
			),
			"text,call,thought",
		);
		await browser.evaluate("document.querySelector('[data-testid=activity-sheet] [data-kind=text] button').click()");
		await browser.wait(
			"document.querySelector('[data-testid=activity-sheet] .detail-prose')?.textContent.includes('Running codemode.')",
		);
		await browser.evaluate("history.back()");
		await browser.evaluate("history.back()");
		await browser.wait("!document.querySelector('[data-testid=activity-sheet]')");
		// 2: the text in the transcript, the call and the thinking on the wheel after it.
		set(2);
		await browser.wait(`${ROWS} === 'text,activity,answer'`);
		// 4: the thinking open, the call as a row that opens its detail.
		set(4);
		await browser.wait(`${ROWS} === 'text,activity,thought,answer' && document.querySelector('.activity-rows')`);
		await browser.wait("document.querySelector('.thinking-body')?.textContent.includes('private-thinking-sentinel')");
		await browser.click(".activity-rows [data-testid=step] button");
		await browser.wait("document.querySelector('[data-testid=activity-sheet] [data-testid=detail-input]')");
		writeFileSync(settings, JSON.stringify(base));
	});

	it("at detail 1, keeps the agent's text on the wheel while it works and fades the answer in once it stopped", async () => {
		const settings = join(fixture.dataDir, "settings.json");
		const base = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
		writeFileSync(settings, JSON.stringify({ ...base, detail: 1 }));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`${ROWS} === 'activity,answer'`);
		// Every row the transcript adds from now on: whether it is an answer, and whether it fades in.
		await browser.evaluate(`(() => {
			window.__added = [];
			new MutationObserver((changes) => {
				for (const change of changes)
					for (const node of change.addedNodes)
						if (node.classList?.contains("row"))
							window.__added.push({ answer: node.textContent.includes('Echo:'), arriving: node.classList.contains("arriving"), complete: Boolean(node.querySelector('.message-actions')) });
			}).observe(document.querySelector('.rows'), { childList: true });
		})()`);
		const chat = await holdIn(fixture.browser(), Chat, { session, conversation: 1 }, "participant");
		// A long streamed answer (the fake model's `slow…`): seen while it streams if anything shows it early.
		await chat.send({ text: "slow answer", requestId: "second" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => !live(view)?.run && JSON.stringify(view).includes("Echo: slow answer"), 30_000);
		chat.release();
		await browser.wait("document.querySelector('.rows').textContent.includes('Echo: slow answer')");
		// The answer once, fading in, complete when it arrives (its Copy and Reply there): not shown while it streamed.
		const added =
			await browser.evaluate<{ answer: boolean; arriving: boolean; complete: boolean }[]>("window.__added");
		assert.deepEqual(
			added.filter((row) => row.answer),
			[{ answer: true, arriving: true, complete: true }],
		);
		writeFileSync(settings, JSON.stringify(base));
	});
});
