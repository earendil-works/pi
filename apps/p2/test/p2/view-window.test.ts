// The windowed conversation view on the real server and a Durable session worker: a long conversation's view holds
// Durable's window (its newest entries, `before` the one just before them); the client's transcript pages in the rest
// through `entries` (also to reach one entry); the active context's numbers come as `stats` and from `costs`; and a
// lingering conversation (`CLIENT_LINGER`) keeps view and pages.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { BACKGROUND_CONTEXT, follow, UI_LINGER, whenLive } from "@p2/app/v1";
import { Chat, ChatCosts } from "../../plugins/chat/contract.ts";
import { Sessions, SessionTransfer } from "../../plugins/sessions/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { transcriptOf } from "../../src/web/history.ts";
import { bigSessionEntries } from "../fixtures/big-session.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const SEEDED = 600;

describe("windowed conversation view", () => {
	let fixture: Fixture;
	let owner: Host;
	let session: string;
	let seeded = 0;
	const chatOf = () => holdIn(owner, Chat, { session, conversation: 1 }, "participant");
	const storeOf = (key: string, chat: Awaited<ReturnType<typeof chatOf>>) =>
		transcriptOf(owner, key, { view: chat.view, entries: (query) => chat.entries(query, BACKGROUND_CONTEXT) });
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		if (sessions.variant !== "owner") throw new Error("owner expected");
		session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		const entries = bigSessionEntries(SEEDED, 4_000);
		seeded = entries.length;
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(SessionTransfer, { session: session })).seed({ entries }, ctx),
			BACKGROUND_CONTEXT,
		);
	});
	after(async () => {
		await fixture?.close();
	});

	it("holds Durable's window; the transcript pages in the rest; stats and costs cover the active context", async () => {
		const chat = await chatOf();
		const store = storeOf(`${session}#1`, chat);
		const stop = store.subscribe(() => {});
		try {
			const view = await until(chat.view, (value) => Boolean(value));
			assert.ok(view);
			assert.ok(view.entries.length >= 50 && view.entries.length <= 100, `${view.entries.length}`);
			assert.ok(view.before !== undefined && view.before < view.entries[0]!.id);
			// Complete entries: a tool result's text as committed.
			assert.ok(view.entries.some((entry) => entry.model?.[0]?.role === "toolResult"));
			// Paging reaches the start: every seeded entry once, in order.
			while (store.value?.view.items[0]?.kind === "earlier") await store.loadEarlier();
			const all = store.value!.view.items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
			assert.equal(all.length, seeded);
			assert.deepEqual(
				all.map((entry) => entry.id),
				all.map((entry) => entry.id).toSorted((a, b) => a - b),
			);
			// The numbers are those of the whole active context, and `costs` lists every response.
			const stats = await until(chat.stats, (value) => Boolean(value));
			const answers = all.flatMap((entry) => {
				const message = entry.model?.[0];
				return message?.role === "assistant" ? [message as AssistantMessage] : [];
			});
			assert.ok((stats?.contextTokens ?? 0) > 0);
			assert.deepEqual(stats?.latestAssistantUsage, answers.at(-1)?.usage);
			const sheet = owner.hold(ChatCosts, { session, conversation: 1 }, BACKGROUND_CONTEXT);
			const costs = await sheet.costs(BACKGROUND_CONTEXT);
			sheet.release();
			assert.equal(costs.length, answers.length);
		} finally {
			stop();
			chat.release();
		}
	});

	it("loads pages until one entry is there (a quoted message, a search hit)", async () => {
		const chat = await chatOf();
		// A store of its own: the conversation's store kept the pages the test before loaded.
		const store = storeOf(`${session}#1 (through)`, chat);
		const stop = store.subscribe(() => {});
		try {
			const view = await until(chat.view, (value) => Boolean(value));
			// Seeded in one commit: the IDs below the window are contiguous.
			const target = view!.entries[0]!.id - 300;
			const held = () => store.value!.view.items.some((item) => item.kind === "entry" && item.entry.id === target);
			assert.ok(!held());
			assert.equal(await store.loadThrough(target), true);
			assert.ok(held());
			// Not in this conversation: false once the start is reached.
			assert.equal(await store.loadThrough(0), false);
		} finally {
			stop();
			chat.release();
		}
	});

	it("appends to the window; the stats follow new entries as the whole context would give them", async () => {
		const chat = await chatOf();
		const store = storeOf(`${session}#1 (append)`, chat);
		const stop = store.subscribe(() => {});
		const stopStats = follow(chat.stats, () => {});
		try {
			const view = await until(chat.view, (value) => Boolean(value));
			const first = view!.entries[0]!.id;
			const stats = await until(chat.stats, (value) => Boolean(value));
			await chat.send({ text: "one more", requestId: "append" }, BACKGROUND_CONTEXT);
			const next = await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) => entry.model?.[0]?.role === "assistant" && entry.id > view!.entries.at(-1)!.id,
					),
				),
			);
			assert.equal(next!.entries[0]!.id, first);
			await until(chat.stats, (value) => value !== stats);
			// No compaction: the active context is every entry, without failed responses.
			while (store.value?.view.items[0]?.kind === "earlier") await store.loadEarlier();
			const messages = store.value!.view.items.flatMap((item) =>
				item.kind !== "entry"
					? []
					: (item.entry.model ?? []).filter(
							(message) =>
								message.role !== "assistant" || !["aborted", "error", "deferred"].includes(message.stopReason),
						),
			);
			// The stats change once per committed entry: wait for the ones of the whole exchange.
			const expected = estimateContextTokens(messages).tokens;
			const after = await until(chat.stats, (value) => value?.contextTokens === expected);
			assert.equal(after?.contextTokens, expected);
		} finally {
			stopStats();
			stop();
			chat.release();
		}
	});

	it("a lingering conversation keeps the view and its pages: switching back finds them at once", async () => {
		const input = { session, conversation: 1 };
		const lingering = fixture.browser();
		const first = lingering.hold(Chat, input, BACKGROUND_CONTEXT);
		await whenLive(first);
		const source = (chat: typeof first) => ({
			view: chat.view,
			entries: (query: Parameters<typeof chat.entries>[0]) => chat.entries(query, BACKGROUND_CONTEXT),
		});
		const store = transcriptOf(lingering, `${session}#1`, source(first));
		const stop = store.subscribe(() => {});
		await until(first.view, (value) => Boolean(value));
		await store.loadEarlier();
		const paged = store.value!.view.items.length;
		stop();
		// Released as the UIs release a conversation: it lingers (UI_LINGER), so its object stays on the server.
		UI_LINGER.release(first, Chat.name);
		const again = lingering.hold(Chat, input, BACKGROUND_CONTEXT);
		try {
			const started = Date.now();
			await whenLive(again);
			assert.ok(Date.now() - started < 1000, "the lingering object binds at once");
			assert.ok(again.view.value, "still hydrated");
			const retained = transcriptOf(lingering, `${session}#1`, source(again));
			const stopAgain = retained.subscribe(() => {});
			assert.equal(retained.value?.view.items.length, paged);
			stopAgain();
		} finally {
			again.release();
			UI_LINGER.flush();
		}
	});
});
