// A session is the authority for its own description (`p2.session-info`): the owner's edits are committed to it first,
// through the running worker or to the stopped session's store, and the catalog row follows the worker's report. A
// session from before the description gets it from its catalog row at its first start.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { readSessionInfo, type SessionInfoState, withStoredSession } from "@p2/app/v1/node";
import { Chat } from "../../plugins/chat/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const answered = (view: ConversationView | null | undefined) =>
	JSON.stringify(view?.entries ?? []).includes("Echo:") && !(view?.docs["pi.live"] as LiveState | undefined)?.run;

describe("the session's own description (fake provider)", () => {
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

	/** Sends one message and waits for its answer: the session's worker runs afterwards. */
	const send = async (session: Session, text: string) => {
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT);
		await until(chat.view, answered);
		chat.release();
	};

	/** Whether the session's worker runs now. */
	const running = (session: Session) => {
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		try {
			return hosts.workers.value?.[session.id]?.running === true;
		} finally {
			hosts.release();
		}
	};

	/** Stops the session's worker: its store is closed and nothing holds it. */
	const stop = async (session: Session) => {
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		try {
			await fixture.server.host.root(
				async (ctx) => (await ctx.get(Hosts, {})).stop({ session: session.id }, ctx),
				BACKGROUND_CONTEXT,
			);
			await until(hosts.workers, (workers) => workers?.[session.id]?.running !== true);
		} finally {
			hosts.release();
		}
	};

	/** The description in the session's store, read while its worker is stopped. */
	const stored = async (session: Session): Promise<SessionInfoState | undefined> => {
		await stop(session);
		return withStoredSession(
			fixture.dataDir,
			session.id,
			(durable) => readSessionInfo(durable, BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
	};

	it("writes the description at the first start, titled from the first user message", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await send(session, "first message\nof the session");
		await until(sessions.sessions, (list) => find(session.id)(list)?.title === "first message of the session");
		const info = await stored(session);
		assert.equal(info?.title, "first message of the session");
		assert.equal(info?.titleEdited, false);
		assert.equal(info?.cwd, fixture.workspace);
		assert.equal(info?.createdAt, session.createdAt);
	});

	it("commits the owner's edits through the running worker", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await send(session, "hello");
		await sessions.rename({ id: session.id, title: "Renamed while running" }, BACKGROUND_CONTEXT);
		await sessions.pin({ id: session.id, pinned: true }, BACKGROUND_CONTEXT);
		const row = await until(sessions.sessions, (list) => find(session.id)(list)?.pinned === true);
		assert.equal(find(session.id)(row)?.title, "Renamed while running");
		const info = await stored(session);
		assert.equal(info?.title, "Renamed while running");
		assert.equal(info?.titleEdited, true);
		assert.equal(info?.pinned, true);
	});

	it("commits the owner's edits to a stopped session's store, starting no worker", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await send(session, "hello");
		await stop(session);
		await sessions.rename({ id: session.id, title: "Renamed while stopped" }, BACKGROUND_CONTEXT);
		await sessions.pin({ id: session.id, pinned: true }, BACKGROUND_CONTEXT);
		const elsewhere = join(fixture.workspace, "moved-while-stopped");
		mkdirSync(elsewhere);
		// A relocation answers once it started (its job moves the row): wait for the row.
		await sessions.relocate({ id: session.id, cwd: elsewhere, env: null }, BACKGROUND_CONTEXT);
		const rows = await until(sessions.sessions, (list) => find(session.id)(list)?.cwd === elsewhere);
		assert.equal(running(session), false);
		const row = find(session.id)(rows);
		assert.equal(row?.title, "Renamed while stopped");
		assert.equal(row?.pinned, true);
		assert.equal(row?.cwd, elsewhere);
		const info = await stored(session);
		assert.equal(info?.title, "Renamed while stopped");
		assert.equal(info?.pinned, true);
		assert.equal(info?.cwd, elsewhere);
	});

	it("records an archive and a restore in the session itself", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Archived one" }, BACKGROUND_CONTEXT);
		await send(session, "hello");
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		assert.notEqual(find(session.id)(sessions.sessions.value)?.archivedAt, null);
		// The archive's job stops the worker and records it in the session's own description.
		await until(sessions.operations, (list) => !list?.some((each) => each.session === session.id));
		assert.notEqual((await stored(session))?.archivedAt, null);
		await sessions.restore({ id: session.id }, BACKGROUND_CONTEXT);
		assert.equal(find(session.id)(sessions.sessions.value)?.archivedAt, null);
		assert.equal((await stored(session))?.archivedAt, null);
	});

	it("keeps a given title over the first user message", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Given title" }, BACKGROUND_CONTEXT);
		await send(session, "this is not the title");
		const info = await stored(session);
		assert.equal(info?.title, "Given title");
		assert.equal(info?.titleEdited, true);
	});
});
