// Unread answers: the server keeps, per session, the latest root answer and how far the owner has read (persisted, any
// device); the sidebar shows a steady dot for an unread answer and the pulsing one while the agent works.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { SessionReads } from "../../plugins/search/contract.ts";
import { SearchDb } from "../../plugins/search/db.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("unread answers", () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture({ web: browserTests });
	});
	after(async () => {
		await fixture?.close();
	});

	it("counts answers from before the read markers existed as read", () => {
		const directory = mkdtempSync(join(tmpdir(), "p2-unread-"));
		try {
			const db = new SearchDb(directory);
			db.index("s1", 1, [{ conversationId: 1, entryId: 7, role: "assistant", timestamp: 1, text: "old answer" }], 7);
			db.close();
			// What an index from before this feature looks like: no reads table yet.
			const raw = new DatabaseSync(join(directory, "search.sqlite"));
			raw.exec("DROP TABLE reads");
			raw.close();
			const upgraded = new SearchDb(directory);
			assert.equal(upgraded.reads().s1, 7);
			upgraded.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("tracks each session's latest root answer and the owner's read marker, persisted and monotonic", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const marks = owner.hold(SessionReads, {}, BACKGROUND_CONTEXT);
		const other = fixture.browser().hold(SessionReads, {}, BACKGROUND_CONTEXT);
		// Values are current while subscribed.
		const keep = [follow(marks.answers, () => {}), follow(marks.reads, () => {})];
		const session = await sessions.create({ cwd: fixture.workspace, title: "Marks" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "first", requestId: "first" }, BACKGROUND_CONTEXT);
		const first = (await until(marks.answers, (answers) => (answers?.[session.id] ?? 0) > 0))?.[session.id] ?? 0;
		assert.equal(marks.reads.value?.[session.id], undefined, "unread until an owner reads it");

		await marks.markRead({ session: session.id, through: first }, BACKGROUND_CONTEXT);
		// Another owner device sees it read.
		await until(other.reads, (reads) => reads?.[session.id] === first);
		await marks.markRead({ session: session.id, through: first - 1 }, BACKGROUND_CONTEXT);
		assert.equal(marks.reads.value?.[session.id], first, "never moves back");

		await chat.send({ text: "second", requestId: "second" }, BACKGROUND_CONTEXT);
		const second = (await until(marks.answers, (answers) => (answers?.[session.id] ?? 0) > first))?.[session.id];
		assert(second && second > (marks.reads.value?.[session.id] ?? 0), "a new answer is unread again");

		const db = new SearchDb(fixture.dataDir);
		try {
			assert.equal(db.reads()[session.id], first);
			assert.equal(db.answers()[session.id], second);
		} finally {
			db.close();
		}
		for (const stop of keep) stop();
		chat.release();
	});

	it(
		"shows the working mark, then a steady unread dot and a bold title, cleared by opening the session",
		{
			skip: !browserTests,
		},
		async () => {
			const owner = fixture.browser();
			const sessions = await holdIn(owner, Sessions, {}, "owner");
			const marks = owner.hold(SessionReads, {}, BACKGROUND_CONTEXT);
			const keep = [follow(marks.answers, () => {}), follow(marks.reads, () => {})];
			const target = await sessions.create({ cwd: fixture.workspace, title: "Answers here" }, BACKGROUND_CONTEXT);
			const elsewhere = await sessions.create({ cwd: fixture.workspace, title: "Looking here" }, BACKGROUND_CONTEXT);
			const browser = await Browser.start();
			await browser.signIn(fixture.owner);
			try {
				await browser.metrics(1280, 900);
				await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${elsewhere.id}`);
				const row = `[...document.querySelectorAll('.session-row')].find(r=>r.querySelector('.session-title')?.textContent.includes('Answers here'))`;
				await browser.wait(`Boolean(${row})`);
				const chat = await holdIn(owner, Chat, { session: target.id, conversation: 1 }, "participant");
				await chat.send({ text: "slow-tool", requestId: "slow" }, BACKGROUND_CONTEXT);
				// Working: a frame around the row's glyph (a spinner where it has none).
				const working = ".working-frame, .working-mark";
				await browser.wait(`Boolean(${row}?.querySelector('${working}'))`);
				await browser.wait(`Boolean(${row}?.querySelector('.unread-dot')) && !${row}?.querySelector('${working}')`);
				assert.equal(
					await browser.evaluate<string>(`getComputedStyle(${row}.querySelector('.unread-dot')).animationName`),
					"none",
					"the unread dot does not move",
				);
				assert.ok(
					await browser.evaluate<boolean>(`${row}.querySelector('.session-title').classList.contains('unread')`),
					"an unread session's title is bold",
				);
				assert.equal(marks.reads.value?.[target.id], undefined);
				await browser.evaluate(`${row}.querySelector('.session-main').click()`);
				await browser.wait(`!${row}?.querySelector('.unread-dot')`);
				const answer = marks.answers.value?.[target.id];
				await until(marks.reads, (reads) => reads?.[target.id] === answer);
				chat.release();
			} finally {
				for (const stop of keep) stop();
				await browser.close();
			}
		},
	);
});
