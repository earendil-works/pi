// Session titles and activity as in Pi Mobile: an automatic title is the first user message (line breaks as spaces,
// 100 characters) until a title is given or renamed (titleEdited); titles are at most 120 characters; a relocation
// counts as activity.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { CatalogDb } from "../../plugins/sessions/catalog.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const answered = (view: ConversationView | null | undefined) =>
	JSON.stringify(view?.entries ?? []).includes("Echo:") && !(view?.docs["pi.live"] as LiveState | undefined)?.run;

describe("session titles (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	const find = (id: string) => (list: readonly Session[] | undefined) => list?.find((session) => session.id === id);
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
	});
	after(async () => {
		await fixture?.close();
	});

	const send = async (session: Session, text: string) => {
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT);
		await until(chat.view, answered);
		chat.release();
	};

	it("titles an untitled session from its first message, then keeps a rename", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		assert.equal(session.title, "New session");
		const first = `first line\nsecond line ${"x".repeat(150)}`;
		await send(session, first);
		const titled = await until(sessions.sessions, (list) => {
			const title = find(session.id)(list)?.title;
			return title !== undefined && title !== "New session";
		});
		assert.equal(find(session.id)(titled)?.title, first.replace(/\n/g, " ").slice(0, 100));
		await sessions.rename({ id: session.id, title: "Kept title" }, BACKGROUND_CONTEXT);
		await send(session, "another message");
		await until(sessions.sessions, (list) => find(session.id)(list)?.title === "Kept title");
	});

	it("keeps a title given at creation", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Given title" }, BACKGROUND_CONTEXT);
		await send(session, "first message");
		const list = await until(sessions.sessions, (value) => Boolean(find(session.id)(value)));
		assert.equal(find(session.id)(list)?.title, "Given title");
	});

	it("limits titles to 120 characters", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Limit" }, BACKGROUND_CONTEXT);
		await sessions.rename({ id: session.id, title: "y".repeat(120) }, BACKGROUND_CONTEXT);
		await assert.rejects(sessions.rename({ id: session.id, title: "y".repeat(121) }, BACKGROUND_CONTEXT));
	});

	it("moves a relocated session up the list", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Moved" }, BACKGROUND_CONTEXT);
		const elsewhere = join(fixture.workspace, "elsewhere");
		mkdirSync(elsewhere);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await sessions.relocate({ id: session.id, cwd: elsewhere, env: null }, BACKGROUND_CONTEXT);
		const list = await until(sessions.sessions, (value) => find(session.id)(value)?.cwd === elsewhere);
		assert.ok((find(session.id)(list)?.updatedAt ?? 0) > session.updatedAt);
	});
});

it("migrates a version-2 catalog: titles other than the placeholder count as given", () => {
	const directory = mkdtempSync(join(tmpdir(), "p2-catalog-"));
	try {
		const db = new DatabaseSync(join(directory, "catalog.sqlite"));
		db.exec(`CREATE TABLE sessions (
			id TEXT PRIMARY KEY, cwd TEXT NOT NULL, env TEXT, title TEXT NOT NULL,
			createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER,
			pinned INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, thinkingLevel TEXT NOT NULL
		) STRICT; PRAGMA user_version=2;`);
		const insert = db.prepare(
			'INSERT INTO sessions VALUES (?,\'/w\',NULL,?,1,1,NULL,0,\'{"provider":"faux","modelId":"faux-1"}\',\'off\')',
		);
		insert.run("a", "Renamed earlier");
		insert.run("b", "New session");
		db.close();
		const catalog = new CatalogDb(directory);
		catalog.activity("a", 2, "first message");
		catalog.activity("b", 2, "first message");
		assert.equal(catalog.get("a").title, "Renamed earlier");
		assert.equal(catalog.get("b").title, "first message");
		catalog.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
