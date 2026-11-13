// Pi Mobile's rebuildIndex: an owner re-indexes one session from the start, an archived one too (its worker scans
// without resuming work and stops again). The rebuild is a job, shown in `Search.rebuilds` while it runs.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Search, SearchIndex } from "../../plugins/search/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { failureOf, holdIn, poll, startFixture, until } from "./helpers.ts";

const answered = (text: string) => (view: ConversationView | null | undefined) =>
	JSON.stringify(view?.entries ?? []).includes(text) && !(view?.docs["pi.live"] as LiveState | undefined)?.run;

test("rebuildIndex re-indexes active and archived sessions", { timeout: 90_000 }, async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const owner = fixture.browser();
	const sessions = await holdIn(owner, Sessions, {}, "owner");
	const search = owner.hold(Search, {}, BACKGROUND_CONTEXT);
	const session = await sessions.create({ cwd: fixture.workspace, title: "Indexed" }, BACKGROUND_CONTEXT);
	const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
	await chat.send({ text: "pangolin rebuild words", requestId: "one" }, BACKGROUND_CONTEXT);
	await until(chat.view, answered("Echo: pangolin rebuild words"));
	const hits = async (archived = false) =>
		(await search.search({ query: "pangolin", archived }, BACKGROUND_CONTEXT)).messages.filter(
			(hit) => hit.session === session.id,
		).length;
	await poll(async () => (await hits()) === 2, 20_000, "indexed");
	const rebuilt = () => until(search.rebuilds, (list) => list?.length === 0);
	chat.release();

	// Emptied directly, the index stays empty until rebuilt.
	await fixture.server.host.root(
		async (ctx) => (await ctx.get(SearchIndex, {})).reset({ session: session.id }, ctx),
		BACKGROUND_CONTEXT,
	);
	assert.equal(await hits(), 0);
	// The rebuild is a job: the call answers once it started, `rebuilds` shows it running until the scan committed.
	await search.rebuildIndex({ session: session.id }, BACKGROUND_CONTEXT);
	await until(search.rebuilds, (list) => list?.some((each) => each.session === session.id) === true);
	await rebuilt();
	assert.equal(await hits(), 2, "rebuilt once the job is gone");

	// An archived session: its worker starts only to scan (no resumed work) and stops again.
	await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
	await fixture.server.host.root(
		async (ctx) => (await ctx.get(SearchIndex, {})).reset({ session: session.id }, ctx),
		BACKGROUND_CONTEXT,
	);
	assert.equal(await hits(true), 0);
	await search.rebuildIndex({ session: session.id }, BACKGROUND_CONTEXT);
	await rebuilt();
	assert.equal(await hits(true), 2);
	const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
	t.after(() => hosts.release());
	await until(hosts.workers, (workers) => workers?.[session.id]?.running === false);
	// Still archived: an ordinary start is refused.
	const refused = owner.hold(Chat, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
	// A failed start leaves its holders waiting (the public error is fixed); the status names the reason.
	assert.match((await failureOf(refused)).message, /failed to start/);
	await until(hosts.workers, (workers) => /archived/i.test(workers?.[session.id]?.error ?? ""));
	refused.release();
	await assert.rejects(search.rebuildIndex({ session: "nope" }, BACKGROUND_CONTEXT), /Session not found/);
});
