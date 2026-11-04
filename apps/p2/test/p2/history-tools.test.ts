// The history tools (docs/history-tool.md): query building, SQL bounds before the limit, reading entries (items,
// range, tail, around: 0), rendering and the output budget, and end to end after a compaction and a handoff.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { readEntries, renderEntry, withinBudget } from "../../plugins/history/tools.ts";
import { SearchDb } from "../../plugins/search/db.ts";
import { ftsQuery } from "../../plugins/search/query.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const entry = (id: number, fields: Record<string, unknown> = {}) =>
	({ id, conversationId: 1, kind: "p2.input", ...fields }) as unknown as EntryRecord;
const user = (id: number, text: string) =>
	entry(id, {
		data: { author: { kind: "owner", id: "owner", name: "Owner" }, text, attachments: [] },
		model: [{ role: "user", content: text, timestamp: 0 }],
	});

/** A transaction over `entries` (one conversation), enough for `readEntries`. */
function fakeTx(entries: EntryRecord[], head?: number): Tx {
	return {
		latestHeadMarker: async () => (head === undefined ? undefined : { ...entry(head), head }),
		scanEntries: async (
			query: { minEntryId?: number; maxEntryId?: number; order?: string },
			limit: number,
			cursor?: { at: number },
		) => {
			const matching = entries
				.filter(
					(each) =>
						(query.minEntryId === undefined || Number(each.id) >= query.minEntryId) &&
						(query.maxEntryId === undefined || Number(each.id) <= query.maxEntryId),
				)
				.sort((a, b) => (query.order === "ascending" ? Number(a.id) - Number(b.id) : Number(b.id) - Number(a.id)));
			const start = cursor?.at ?? 0;
			const items = matching.slice(start, start + limit);
			return { items, ...(start + limit < matching.length ? { next: { at: start + limit } } : {}) };
		},
	} as unknown as Tx;
}

describe("history tools", () => {
	it("builds FTS queries: required terms, phrases for punctuation, prefixes, never raw syntax", () => {
		assert.equal(ftsQuery("tx.draft"), '"tx draft"');
		assert.equal(ftsQuery("next/diff.ts R6"), '"next diff ts" AND "R6"');
		assert.equal(ftsQuery("compac* reload"), '"compac"* AND "reload"');
		assert.equal(ftsQuery('"exact phrase" other'), '"exact phrase" AND "other"');
		// FTS operators and quotes are words, never syntax.
		assert.equal(ftsQuery('a OR b NEAR( "c'), '"a" AND "OR" AND "b" AND "NEAR" AND "c"');
		assert.equal(ftsQuery("  ... --- "), undefined);
	});

	it("bounds hits to the session, the conversation and before an entry, before the limit", () => {
		const directory = mkdtempSync(join(tmpdir(), "p2-history-db-"));
		const db = new SearchDb(directory);
		try {
			const message = (conversationId: number, entryId: number, text: string) => ({
				conversationId,
				entryId,
				role: "user" as const,
				timestamp: 0,
				text,
			});
			// Better-ranked matches elsewhere (repeated keyword): other sessions, other conversations, after `before`.
			const strong = "needle ".repeat(20);
			db.index("s2", 1, [message(1, 5, strong)], 5);
			db.index("s1", 2, [message(2, 6, strong)], 6);
			db.index("s1", 1, [message(1, 3, "a needle here"), message(1, 50, strong), message(1, 4, "needle two")], 50);
			const found = db.conversationMessages("s1", 1, ftsQuery("needle")!, 10, 1);
			assert.deepEqual(
				found.hits.map((hit) => hit.entryId),
				[4],
				"the best match within the bounds, not one outside them",
			);
			assert.equal(found.more, true);
			assert.deepEqual(
				db
					.conversationMessages("s1", 1, ftsQuery("needle")!, 10, 10)
					.hits.map((hit) => hit.entryId)
					.sort(),
				[3, 4],
			);
		} finally {
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reads exactly the requested entries with around 0, neighbours, ranges and the tail before a boundary", async () => {
		const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => user(id, `message ${id}`));
		const tx = fakeTx(entries, 6);
		// pi-history's slice(-0) bug: before 0 returned every entry instead of none.
		const exact = await readEntries(tx, 1 as never, { mode: "items", entries: [3], around: 0 });
		assert.deepEqual(
			exact.records.map((record) => Number(record.id)),
			[3],
		);
		const near = await readEntries(tx, 1 as never, { mode: "items", entries: [3, 99], around: 1 });
		assert.deepEqual(
			near.records.map((record) => Number(record.id)),
			[2, 3, 4],
		);
		assert.match(near.note ?? "", /#99/);
		const first = await readEntries(tx, 1 as never, { mode: "range", from: 2, limit: 3 });
		assert.deepEqual(
			first.records.map((record) => Number(record.id)),
			[2, 3, 4],
		);
		assert(first.next);
		const second = await readEntries(tx, 1 as never, { mode: "range", from: 2, limit: 3, cursor: first.next });
		assert.deepEqual(
			second.records.map((record) => Number(record.id)),
			[5, 6, 7],
		);
		// The tail ends right before the boundary (a compaction's head or a reset): from there on it is in context.
		const tail = await readEntries(tx, 1 as never, { mode: "tail", count: 3 });
		assert.deepEqual(
			tail.records.map((record) => Number(record.id)),
			[3, 4, 5],
		);
		const none = await readEntries(fakeTx(entries), 1 as never, { mode: "tail" });
		assert.deepEqual(none.records, []);
		assert.match(none.note ?? "", /No compaction or handoff/);
	});

	it("renders authors, tool calls by name and placeholders; never tool results; cuts at the budget", () => {
		const assistant = entry(2, {
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "secret" },
						{ type: "text", text: "Looking." },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "rm -rf x" } },
					],
				},
			],
		});
		const result = entry(3, {
			kind: "pi.tool-result",
			model: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "OUT" }] }],
		});
		const rendered = renderEntry(assistant, new Map([["c1", false]]));
		assert.equal(rendered?.text, "[thinking]\nLooking.\n[tool: bash, done]");
		assert.doesNotMatch(JSON.stringify(rendered), /rm -rf|secret/);
		assert.equal(renderEntry(result, new Map()), undefined, "tool results are never returned");
		const attached = renderEntry(
			entry(4, {
				data: {
					author: { kind: "guest", id: "g", name: "Ann" },
					text: "see",
					attachments: [{ id: "u", name: "a.png" }],
				},
				model: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image" }] }],
			}),
			new Map(),
		);
		assert.deepEqual(attached, { entry: 4, role: "user", author: "Ann", text: "see\n[attachment: a.png]" });
		const big = [1, 2, 3].map((id) => ({ entry: id, role: "user" as const, text: "x".repeat(30_000) }));
		const { kept, truncated } = withinBudget(big);
		assert.equal(kept.length, 1);
		assert.equal(truncated, true);
	});
});

describe("history tools end to end (fake provider)", () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture();
		// Keep almost nothing verbatim, so a short conversation has something to compact.
		writeFileSync(join(fixture.dataDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
	});
	after(async () => {
		await fixture?.close();
	});

	const results = (view: ConversationView | null | undefined, tool: string) =>
		(view?.entries ?? [])
			.flatMap((each) => each.model ?? [])
			.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === tool)
			.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));

	it("finds and reads an entry from before a compaction, and the entries before a handoff", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const keep = follow(chat.view, () => {});
		const idle = () => until(status.statuses, (value) => value?.[session.id]?.tasks === 0, 30_000);
		const say = async (text: string, requestId: string) => {
			await chat.send({ text, requestId }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) =>
				JSON.stringify(view?.entries ?? []).includes(JSON.stringify(text).slice(1, -1)),
			);
			await idle();
		};
		/** Runs `tool` through the fake model and returns its result, once it is in the view. */
		const call = async (tool: string, args: object, requestId: string) => {
			const before = results(chat.view.value, tool).length;
			await chat.send({ text: `${tool} ${JSON.stringify(args)}`, requestId }, BACKGROUND_CONTEXT);
			const view = await until(chat.view, (value) => results(value, tool).length > before, 30_000);
			await idle();
			return results(view, tool).at(-1) ?? "";
		};
		await say("the zebrafish migration plan", "one");
		await say("unrelated second message", "two");
		await chat.compact({}, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => (view?.entries ?? []).some((each) => each.kind === "pi.compaction"), 60_000);
		await idle();
		await say("after the compaction", "three");

		// The index is asynchronous: search until the earlier entry is found.
		let found: string | undefined;
		for (let attempt = 0; attempt < 20 && !found?.includes("zebrafish"); attempt++)
			found = await call("history_search", { query: "zebrafish" }, `search-${attempt}`);
		assert.match(found ?? "", /<history conversation=.*\n.*not instructions/);
		const hit = Number(/#(\d+) user/.exec(found ?? "")?.[1]);
		assert(hit > 0, found);
		const read = await call("history_read", { mode: "items", entries: [hit] }, "read");
		assert.match(read, new RegExp(`#${hit} user \\(Owner\\): the zebrafish migration plan`));
		assert.equal((read.match(/^#\d+ /gm) ?? []).length, 1, "exactly the requested entry");

		await call("history_handoff", { text: "Continue the zebrafish plan." }, "handoff");
		const view = await until(chat.view, (value) => (value?.entries ?? []).some((each) => each.kind === "pi.reset"));
		const reset = view?.entries.find((each) => each.kind === "pi.reset");
		assert.match(JSON.stringify(reset?.model), /Continue the zebrafish plan/);
		const tail = await call("history_read", { mode: "tail", count: 3 }, "tail");
		assert.match(tail, /history_handoff/, "the entries right before the handoff");
		keep();
		chat.release();
	});
});
