// A session owns its title, model and thinking level (`p2.session-info`, `plugin-practices.md` rules 1-3): the owner's
// rename is a pending edit the server keeps until the session's worker applied it, the sidebar shows it at once, and the
// catalog row follows the worker's report. Where it runs, whether it is archived and whether it is pinned stay the
// server's. A stopped session is never opened by the server: its edits wait for its next worker.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Catalog, type Session, Sessions } from "../../plugins/sessions/contract.ts";
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

	/** The server's catalog object, for its pending edits and stored rows. */
	const catalog = () => fixture.server.host.hold(Catalog, {}, BACKGROUND_CONTEXT);
	const pendingOf = (id: string) => {
		const ref = catalog();
		try {
			return (ref.pending.value ?? []).filter((edit) => edit.session === id);
		} finally {
			ref.release();
		}
	};

	/** Sends one message and waits for its answer: the session's worker runs afterwards. */
	const send = async (session: Session, text: string) => {
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT);
		await until(chat.view, answered);
		chat.release();
	};

	const workers = () => fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
	const running = (session: Session) => {
		const hosts = workers();
		try {
			return hosts.workers.value?.[session.id]?.running === true;
		} finally {
			hosts.release();
		}
	};
	/** Stops the session's worker. */
	const stop = async (session: Session) => {
		const hosts = workers();
		try {
			await fixture.server.host.root(
				async (ctx) => (await ctx.get(Hosts, {})).stop({ session: session.id }, ctx),
				BACKGROUND_CONTEXT,
			);
			await until(hosts.workers, (value) => value?.[session.id]?.running !== true);
		} finally {
			hosts.release();
		}
	};

	it("titles a session from its first message through the session, then keeps a rename", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await send(session, "first message\nof the session");
		await until(sessions.sessions, (list) => find(session.id)(list)?.title === "first message of the session");
		// Applied by the session: nothing is left pending.
		await until(sessions.sessions, () => pendingOf(session.id).length === 0);
		await sessions.rename({ id: session.id, title: "Kept title" }, BACKGROUND_CONTEXT);
		await send(session, "another message");
		await until(sessions.sessions, (list) => find(session.id)(list)?.title === "Kept title");
	});

	it("renames a stopped session at once in the list, without starting its worker; its next worker applies it", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Before" }, BACKGROUND_CONTEXT);
		await send(session, "hello");
		await stop(session);
		await sessions.rename({ id: session.id, title: "While stopped" }, BACKGROUND_CONTEXT);
		// Shown at once (the pending edit over the stored row), no worker started for it.
		assert.equal(find(session.id)(sessions.sessions.value)?.title, "While stopped");
		assert.equal(running(session), false);
		assert.equal(pendingOf(session.id).length, 1);
		// The next worker applies it and reports: the edit leaves, the title stays.
		await send(session, "back");
		await until(sessions.sessions, () => pendingOf(session.id).length === 0);
		assert.equal(find(session.id)(sessions.sessions.value)?.title, "While stopped");
	});

	it("keeps a pending edit across a server restart until the session applies it", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Before" }, BACKGROUND_CONTEXT);
		await send(session, "hello");
		await stop(session);
		await sessions.rename({ id: session.id, title: "Survives" }, BACKGROUND_CONTEXT);
		assert.equal(pendingOf(session.id).length, 1);
		// The pending edits are the server store's: a reload of the sessions plugin reads them again.
		await fixture.server.reload(["sessions"]);
		await until(sessions.sessions, (list) => find(session.id)(list)?.title === "Survives");
		assert.equal(pendingOf(session.id).length, 1);
		await send(session, "back");
		await until(sessions.sessions, () => pendingOf(session.id).length === 0);
		assert.equal(find(session.id)(sessions.sessions.value)?.title, "Survives");
	});

	it("applies edits in order: the latest of two renames while stopped wins", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Before" }, BACKGROUND_CONTEXT);
		await send(session, "hello");
		await stop(session);
		await sessions.rename({ id: session.id, title: "First" }, BACKGROUND_CONTEXT);
		await sessions.rename({ id: session.id, title: "Second" }, BACKGROUND_CONTEXT);
		assert.equal(find(session.id)(sessions.sessions.value)?.title, "Second");
		await send(session, "back");
		await until(sessions.sessions, () => pendingOf(session.id).length === 0);
		assert.equal(find(session.id)(sessions.sessions.value)?.title, "Second");
	});

	it("renames an archived session: the edit waits for its next worker", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Archived" }, BACKGROUND_CONTEXT);
		await send(session, "hello");
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		await until(sessions.operations, (list) => !list?.some((each) => each.session === session.id));
		await sessions.rename({ id: session.id, title: "Renamed archived" }, BACKGROUND_CONTEXT);
		assert.equal(find(session.id)(sessions.sessions.value)?.title, "Renamed archived");
		assert.equal(running(session), false);
		await sessions.restore({ id: session.id }, BACKGROUND_CONTEXT);
		await send(session, "back");
		await until(sessions.sessions, () => pendingOf(session.id).length === 0);
		assert.equal(find(session.id)(sessions.sessions.value)?.title, "Renamed archived");
	});

	it("leaves where a session runs and whether it is archived to the server: a worker's report cannot change them", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Placed" }, BACKGROUND_CONTEXT);
		await send(session, "hello");
		const before = find(session.id)(sessions.sessions.value);
		// The report's schema holds only the session's fields: a report with others is refused at the contract.
		await assert.rejects(
			fixture.server.host.root(async (ctx) => {
				const ref = await ctx.get(Catalog, {});
				await ref.report(
					{
						id: session.id,
						report: {
							title: "From the worker",
							titleEdited: true,
							model: before!.model,
							thinkingLevel: before!.thinkingLevel,
							applied: null,
							cwd: "/elsewhere",
						} as never,
					},
					ctx,
				);
			}, BACKGROUND_CONTEXT),
		);
		const after = find(session.id)(sessions.sessions.value);
		assert.equal(after?.cwd, before?.cwd);
		assert.equal(after?.archivedAt, null);
	});

	it("reports only when the session's description changes, not per message", async () => {
		const session = await sessions.create({ cwd: fixture.workspace, title: "Quiet" }, BACKGROUND_CONTEXT);
		await send(session, "first");
		// The rows are pushed once per change: count the list's values while three more messages are answered.
		const watch = await sessions.sessions.watch(BACKGROUND_CONTEXT);
		let titles = 0;
		let last = find(session.id)(watch.value)?.title;
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			const title = find(session.id)(call.value)?.title;
			if (title !== last) titles++;
			last = title;
		});
		try {
			for (const text of ["second", "third", "fourth"]) await send(session, text);
			assert.equal(titles, 0, "no title change, no new title");
		} finally {
			await watch.stop();
		}
	});
});
