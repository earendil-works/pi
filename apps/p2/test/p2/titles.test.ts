// Session titles and activity as in Pi Mobile: an automatic title is the first user message (line breaks as spaces,
// 100 characters) until a title is given or renamed (titleEdited); titles are at most 120 characters; a relocation
// counts as activity.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Catalog, type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { migrateData } from "../../scripts/migrate-data.ts";
import { startServer } from "../../src/hosts/server.ts";
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

it("migrate-data moves a catalog.sqlite of any version into the server's store, once", async () => {
	const root = mkdtempSync(join(tmpdir(), "p2-catalog-"));
	const dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });
	try {
		// A version-2 catalog: before `titleEdited`, `main` and `branches`.
		const db = new DatabaseSync(join(dataDir, "catalog.sqlite"));
		db.exec(`CREATE TABLE sessions (
			id TEXT PRIMARY KEY, cwd TEXT NOT NULL, env TEXT, title TEXT NOT NULL,
			createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER,
			pinned INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, thinkingLevel TEXT NOT NULL
		) STRICT; PRAGMA user_version=2;`);
		const insert = db.prepare(
			'INSERT INTO sessions VALUES (?,\'/w\',NULL,?,1,?,?,?,\'{"provider":"faux","modelId":"faux-1"}\',\'off\')',
		);
		insert.run("a", "Renamed earlier", 5, null, 1);
		insert.run("b", "New session", 3, 4, 0);
		db.close();

		// Refused until migrated; a dry run changes nothing.
		await assert.rejects(startServer({ dataDir, port: 0, fake: true, web: false }), /migrate-data/);
		const dry = await migrateData({ dataDir, dryRun: true });
		assert.deepEqual(dry.catalog, { kind: "migrated", sessions: 2 });
		assert.equal(existsSync(join(dataDir, "catalog.sqlite")), true);
		const migrated = await migrateData({ dataDir, dryRun: false });
		assert.deepEqual(migrated.catalog, { kind: "migrated", sessions: 2 });
		assert.equal(existsSync(join(dataDir, "catalog.sqlite")), false);
		assert.equal(existsSync(join(dataDir, "pre-catalog-backup", "catalog.sqlite")), true);
		assert.deepEqual((await migrateData({ dataDir, dryRun: false })).catalog, { kind: "absent" });

		const server = await startServer({ dataDir, port: 0, fake: true, web: false });
		try {
			const catalog = await server.host.get(Catalog, {}, BACKGROUND_CONTEXT);
			try {
				assert.deepEqual(
					catalog.sessions.value.map(({ id, title, updatedAt, archivedAt, pinned, main, branches }) => ({
						id,
						title,
						updatedAt,
						archivedAt,
						pinned,
						main,
						branches,
					})),
					[
						{
							id: "a",
							title: "Renamed earlier",
							updatedAt: 5,
							archivedAt: null,
							pinned: true,
							main: 1,
							branches: [],
						},
						{ id: "b", title: "New session", updatedAt: 3, archivedAt: 4, pinned: false, main: 1, branches: [] },
					],
				);
				// Version 2 had no flag: a title other than the placeholder counts as given.
				await catalog.activity({ id: "a", timestamp: 6, firstUserText: "first message" }, BACKGROUND_CONTEXT);
				await catalog.activity({ id: "b", timestamp: 6, firstUserText: "first message" }, BACKGROUND_CONTEXT);
				assert.equal((await catalog.get({ id: "a" }, BACKGROUND_CONTEXT)).title, "Renamed earlier");
				assert.equal((await catalog.get({ id: "b" }, BACKGROUND_CONTEXT)).title, "first message");
			} finally {
				catalog.release();
			}
		} finally {
			await server.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("a worker's view of its own row changes only with that row", async () => {
	const fixture = await startFixture();
	try {
		const model = { provider: "faux", modelId: "faux-1" };
		const catalog = await fixture.server.host.get(Catalog, {}, BACKGROUND_CONTEXT);
		const [a, b] = [
			await catalog.create({ cwd: fixture.workspace, title: "A", model, thinkingLevel: "off" }, BACKGROUND_CONTEXT),
			await catalog.create({ cwd: fixture.workspace, title: "B", model, thinkingLevel: "off" }, BACKGROUND_CONTEXT),
		];
		// Each held as its own worker would hold it (no worker started: only the views are under test).
		const viewOf = async (id: string) =>
			holdIn(fixture.as({ kind: "worker", session: id, generation: 1 }), Sessions, {}, "worker");
		const [viewA, viewB] = [await viewOf(a.id), await viewOf(b.id)];
		const calls = { a: 0, b: 0 };
		const watchA = await viewA.session.watch(BACKGROUND_CONTEXT);
		const watchB = await viewB.session.watch(BACKGROUND_CONTEXT);
		watchA.start(async (call) => void (call.kind === "value" && calls.a++));
		watchB.start(async (call) => void (call.kind === "value" && calls.b++));
		try {
			assert.equal(watchA.value?.title, "A");
			assert.equal(watchB.value?.title, "B");
			// Activity and a rename of A: A's view follows, B's hears nothing.
			await catalog.activity({ id: a.id, timestamp: Date.now() + 1000 }, BACKGROUND_CONTEXT);
			await catalog.update({ id: a.id, title: "A renamed" }, BACKGROUND_CONTEXT);
			await until(viewA.session, (row) => row?.title === "A renamed");
			assert.ok(calls.a >= 1);
			assert.equal(calls.b, 0);
			assert.equal(viewB.session.value?.title, "B");
		} finally {
			await watchA.stop();
			await watchB.stop();
			viewA.release();
			viewB.release();
			catalog.release();
		}
	} finally {
		await fixture.close();
	}
});
