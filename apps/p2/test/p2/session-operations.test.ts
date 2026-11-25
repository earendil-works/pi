// The sessions' lifecycle as the owner's pages see it (fake provider): client-chosen IDs (a page holds the new
// session before `create` answered), methods that answer once their visible effect committed on the server, and the
// long parts as jobs in `Sessions.operations`; the worker pushing what the server's index shows (`/tree`'s main
// conversation) before its method answers.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Catalog, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionTree } from "../../plugins/tree/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const answered = (text: string) => (view: ConversationView | null | undefined) =>
	JSON.stringify(view?.entries ?? []).includes(text);

describe("session operations (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
	});
	after(async () => {
		await fixture?.close();
	});
	/** The server's catalog, read on the server: what the owner's call committed before it answered. */
	const catalogRow = async (id: string) => {
		const catalog = fixture.server.host.hold(Catalog, {}, BACKGROUND_CONTEXT);
		await whenLive(catalog);
		const row = catalog.sessions.value.find((each) => each.id === id);
		catalog.release();
		return row;
	};

	it("creates a session under the client's ID; the page held it before the answer", async () => {
		const id = randomUUID();
		// The page navigates at once: its conversation's worker waits for the row.
		const early = holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		const created = await sessions.create({ id, cwd: fixture.workspace, title: "Chosen" }, BACKGROUND_CONTEXT);
		assert.equal(created.id, id);
		assert.deepEqual(
			await sessions.create({ id, cwd: fixture.workspace, title: "Chosen" }, BACKGROUND_CONTEXT),
			created,
			"a retry answers the same row",
		);
		const chat = await early;
		await chat.send({ text: "hello", requestId: "one" }, BACKGROUND_CONTEXT);
		await until(chat.view, answered("Echo: hello"));
		chat.release();
	});

	it("archives at once and runs the cleanup as an operation; a restore waits for it", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "hi", requestId: "one" }, BACKGROUND_CONTEXT);
		await until(chat.view, answered("Echo: hi"));
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		assert.notEqual((await catalogRow(session.id))?.archivedAt, null, "archived when the call answered");
		// Restored right away: the running archive's worker stop lands before the restore.
		await sessions.restore({ id: session.id }, BACKGROUND_CONTEXT);
		assert.equal((await catalogRow(session.id))?.archivedAt, null);
		await until(sessions.operations, (list) => !(list ?? []).some((each) => each.session === session.id));
		await until(chat.state, (state) => state.kind === "live");
		await chat.send({ text: "back", requestId: "two" }, BACKGROUND_CONTEXT);
		await until(chat.view, answered("Echo: back"));
		chat.release();
	});

	it("rejects a move to a missing directory at once; nothing runs", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await assert.rejects(
			sessions.relocate({ id: session.id, cwd: `${fixture.workspace}/missing`, env: null }, BACKGROUND_CONTEXT),
			/ENOENT|not a directory/,
		);
		assert.deepEqual(
			(sessions.operations.value ?? []).filter((each) => each.session === session.id),
			[],
		);
	});

	it("pushes a /tree switch to the catalog before the worker answers", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "first", requestId: "one" }, BACKGROUND_CONTEXT);
		await until(chat.view, answered("Echo: first"));
		await chat.send({ text: "second", requestId: "two" }, BACKGROUND_CONTEXT);
		await until(chat.view, answered("Echo: second"));
		const tree = await holdIn(owner, SessionTree, { session: session.id }, "owner");
		const nodes = (await tree.tree(BACKGROUND_CONTEXT)).nodes;
		const answer = nodes.find((node) => node.role === "assistant" && node.text === "Echo: first");
		assert(answer);
		const { conversation } = await tree.navigate({ entry: answer.entry }, BACKGROUND_CONTEXT);
		assert.notEqual(conversation, 1);
		assert.equal((await catalogRow(session.id))?.main, conversation, "the catalog follows before the answer");
		await tree.select({ conversation: 1 }, BACKGROUND_CONTEXT);
		assert.equal((await catalogRow(session.id))?.main, 1);
		tree.release();
		chat.release();
	});
});
