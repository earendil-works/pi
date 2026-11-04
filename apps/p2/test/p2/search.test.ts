// Search: root messages indexed by acknowledged catch-up from the worker, titles and directories, archive scope,
// and an index that outlives workers and server restarts.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, type Held, isChordError, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Search, SearchFeed, SearchIndex } from "../../plugins/search/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { type P2Server, startServer } from "../../src/hosts/server.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

describe("search (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let search: Held<typeof Search>;
	let session: Session;
	let other: Session;

	/** Polls a search until `predicate` holds (indexing is asynchronous). */
	const found = async (
		query: string,
		predicate: (results: Awaited<ReturnType<typeof search.search>>) => boolean,
		archived = false,
	) => {
		let last: Awaited<ReturnType<typeof search.search>> | undefined;
		await poll(
			async () => {
				last = await search.search({ query, archived }, BACKGROUND_CONTEXT);
				return predicate(last);
			},
			20_000,
			`search ${JSON.stringify(query)}`,
		);
		assert(last);
		return last;
	};
	const cursor = (server: P2Server, id: string) =>
		server.host.root(
			async (ctx) => (await ctx.get(SearchIndex, {})).cursor({ session: id }, ctx),
			BACKGROUND_CONTEXT,
		);
	const chatOf = (id: string) => holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");

	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		search = owner.hold(Search, {}, BACKGROUND_CONTEXT);
		session = await sessions.create({ cwd: fixture.workspace, title: "Zebra migration" }, BACKGROUND_CONTEXT);
		other = await sessions.create({ cwd: fixture.workspace, title: "Unrelated" }, BACKGROUND_CONTEXT);
	});

	after(async () => {
		await fixture?.close();
	});

	it("finds root user and assistant messages, never the speaker block", async () => {
		const chat = await chatOf(session.id);
		await chat.send({ text: "please index quokka pancakes", requestId: "q" }, BACKGROUND_CONTEXT);
		const results = await found("quokka", (value) => value.messages.length === 2);
		assert.deepEqual(results.messages.map((hit) => hit.role).sort(), ["assistant", "user"]);
		for (const hit of results.messages) {
			assert.equal(hit.session, session.id);
			assert.equal(hit.conversationId, 1);
			assert.equal(hit.title, "Zebra migration");
			assert.match(hit.text, /quokka/);
		}
		assert.deepEqual((await search.search({ query: "mobile-speaker" }, BACKGROUND_CONTEXT)).messages, []);
		assert.deepEqual(
			(await search.search({ query: "owner" }, BACKGROUND_CONTEXT)).messages,
			[],
			"the author header is not indexed",
		);
		// Every term must match, literally (no FTS syntax).
		assert.equal((await search.search({ query: "quokka absent-term" }, BACKGROUND_CONTEXT)).messages.length, 0);
		assert.equal((await search.search({ query: 'quokka" OR "x' }, BACKGROUND_CONTEXT)).messages.length, 0);
		// The cursor reached the newest entry: the whole range was acknowledged.
		const view = await until(chat.view, (value) => Boolean(value?.entries.length));
		const newest = Math.max(...(view?.entries ?? []).map((entry) => entry.id));
		await poll(async () => (await cursor(fixture.server, session.id)) >= newest, 10_000, "cursor");
	});

	it("matches titles and working directories", async () => {
		const results = await search.search({ query: "zebra" }, BACKGROUND_CONTEXT);
		assert.deepEqual(results.sessions, [session.id]);
		assert.deepEqual(results.messages, []);
		const all = await search.search({ query: fixture.workspace.slice(-12) }, BACKGROUND_CONTEXT);
		assert.deepEqual([...all.sessions].sort(), [session.id, other.id].sort());
	});

	it("catches up after the index lost a range", async () => {
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(SearchIndex, {})).reset({ session: session.id }, ctx),
			BACKGROUND_CONTEXT,
		);
		assert.deepEqual((await search.search({ query: "quokka" }, BACKGROUND_CONTEXT)).messages, []);
		// The next start of the worker scans from the server's cursor (now 0) again.
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(Hosts, {})).stop({ session: session.id }, ctx),
			BACKGROUND_CONTEXT,
		);
		const chat = await chatOf(session.id);
		await found("quokka", (value) => value.messages.length === 2);
		await chat.send({ text: "a second wombat", requestId: "w" }, BACKGROUND_CONTEXT);
		await found("wombat", (value) => value.messages.length === 2);
	});

	it("searches archived sessions separately", async () => {
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		assert.deepEqual((await search.search({ query: "quokka" }, BACKGROUND_CONTEXT)).messages, []);
		assert.equal((await search.search({ query: "quokka", archived: true }, BACKGROUND_CONTEXT)).messages.length, 2);
		assert.deepEqual((await search.search({ query: "zebra", archived: true }, BACKGROUND_CONTEXT)).sessions, [
			session.id,
		]);
		await sessions.restore({ id: session.id }, BACKGROUND_CONTEXT);
	});

	it("indexes subagent messages with independent cursors", async () => {
		const chat = await chatOf(other.id);
		await chat.send({ text: "subagent", requestId: "child" }, BACKGROUND_CONTEXT);
		const children = await holdIn(owner, Subagents, {}, "reader");
		const listed = await until(children.children, (value) => Boolean(value?.[other.id]?.length));
		const id = listed![other.id]![0]!.conversationId;
		await found("hello helper", (value) => value.messages.some((hit) => hit.conversationId === id));
		const sub = await holdIn(owner, Chat, { session: other.id, conversation: id }, "participant");
		await sub.send({ text: "child axolotl", requestId: "ax" }, BACKGROUND_CONTEXT);
		const results = await found("axolotl", (value) => value.messages.length === 2);
		assert.ok(results.messages.every((hit) => hit.session === other.id && hit.conversationId === id));
		await fixture.server.host.root(async (ctx) => {
			const index = await ctx.get(SearchIndex, {});
			assert.ok((await index.cursor({ session: other.id, conversation: id }, ctx)) > 0);
			assert.ok((await index.cursor({ session: other.id, conversation: 1 }, ctx)) > 0);
		}, BACKGROUND_CONTEXT);
		sub.release();
		children.release();
	});

	it("derives a default title once and advances activity without undoing renames", async () => {
		const fresh = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const chat = await chatOf(fresh.id);
		await chat.send({ text: "first capybara prompt", requestId: "first" }, BACKGROUND_CONTEXT);
		await found("capybara", (value) => value.messages.length === 2);
		const initial = await until(sessions.sessions, (value) =>
			Boolean(
				value?.some(
					(s) => s.id === fresh.id && s.title === "first capybara prompt" && s.updatedAt > fresh.updatedAt,
				),
			),
		);
		const timestamp = initial!.find((s) => s.id === fresh.id)!.updatedAt;
		await sessions.rename({ id: fresh.id, title: "Explicit title" }, BACKGROUND_CONTEXT);
		await chat.send({ text: "second platypus prompt", requestId: "second" }, BACKGROUND_CONTEXT);
		await found("platypus", (value) => value.messages.length === 2);
		await until(sessions.sessions, (value) =>
			Boolean(value?.some((s) => s.id === fresh.id && s.title === "Explicit title" && s.updatedAt > timestamp)),
		);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(SearchIndex, {})).reset({ session: fresh.id }, ctx),
			BACKGROUND_CONTEXT,
		);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(Hosts, {})).stop({ session: fresh.id }, ctx),
			BACKGROUND_CONTEXT,
		);
		await chatOf(fresh.id);
		const rebuilt = await found("capybara", (value) => value.messages.length === 2);
		assert.ok(rebuilt.messages.every((hit) => hit.title === "Explicit title"));
	});

	it("takes index batches only from session workers", async () => {
		await assert.rejects(
			whenLive(owner.hold(SearchFeed, {}, BACKGROUND_CONTEXT)),
			(error) => isChordError(error) && error.code === "forbidden",
		);
	});
});

describe("search across restarts", () => {
	it("serves the index without starting workers", async () => {
		const fixture = await startFixture();
		let restarted: P2Server | undefined;
		try {
			const owner = fixture.browser();
			const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
				{ cwd: fixture.workspace },
				BACKGROUND_CONTEXT,
			);
			const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
			await chat.send({ text: "persistent narwhal", requestId: "n" }, BACKGROUND_CONTEXT);
			const search = owner.hold(Search, {}, BACKGROUND_CONTEXT);
			await poll(
				async () => (await search.search({ query: "narwhal" }, BACKGROUND_CONTEXT)).messages.length === 2,
				20_000,
				"indexed",
			);
			const { dataDir } = fixture;
			await owner.close(BACKGROUND_CONTEXT);
			const port = fixture.server.port;
			await fixture.server.close();
			restarted = await startServer({ dataDir, port, fake: true, web: false });
			const again = fixture.browser().hold(Search, {}, BACKGROUND_CONTEXT);
			assert.equal((await again.search({ query: "narwhal" }, BACKGROUND_CONTEXT)).messages.length, 2);
			const workers = await restarted.host.root(async (ctx) => {
				const hosts = await ctx.get(Hosts, {});
				return whenLive(hosts).then(() => hosts.workers.value ?? {});
			}, BACKGROUND_CONTEXT);
			assert.deepEqual(Object.keys(workers), [], "no worker was started");
		} finally {
			await restarted?.close();
			await fixture.close();
		}
	});
});
