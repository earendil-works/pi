// The active context's numbers kept from appended entries (src/runtime/conversation-stats.ts `ContextTally`): equal to
// pi-ai's estimate over the whole context, and asking for a whole context when the range changes otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView, ConversationView, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { ContextTally } from "../../src/runtime/conversation-stats.ts";

const usage = (total: number): Usage => ({
	input: total,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: total,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const answer = (text: string, total: number, stopReason: AssistantMessage["stopReason"] = "stop"): Message =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		usage: usage(total),
		timestamp: 2,
	}) as AssistantMessage;
const entry = (id: number, message?: Message, extra: Partial<EntryRecord> = {}): EntryRecord =>
	({
		id: id as EntryId,
		conversationId: 1,
		kind: "x",
		...(message ? { model: [message] } : {}),
		...extra,
	}) as EntryRecord;
const window = (entries: EntryRecord[], before?: number): ConversationView =>
	({
		conversation: { id: 1 },
		entries,
		docs: {},
		...(before === undefined ? {} : { before }),
	}) as unknown as ConversationView;
/** A context of `entries` as Durable builds it: their messages, without aborted, failed and deferred responses. */
const contextOf = (entries: EntryRecord[]): ContextView =>
	({
		head: undefined,
		entries,
		contributions: [],
		messages: entries.flatMap((each) =>
			(each.model ?? []).filter(
				(message) => message.role !== "assistant" || !["aborted", "error", "deferred"].includes(message.stopReason),
			),
		),
	}) as unknown as ContextView;

test("appended entries give what pi-ai's estimate gives over the whole context", () => {
	const all = [
		entry(1, user("first question")),
		entry(2, answer("first answer", 1000)),
		entry(3, user("x".repeat(350))),
		entry(5, answer("failed", 5000, "error")),
		entry(6),
		entry(7, answer("second answer", 2000)),
		entry(8, user("y".repeat(700))),
		entry(9, answer("no usage", 0)),
	];
	const tally = new ContextTally();
	tally.reset(contextOf(all.slice(0, 2)));
	for (let end = 3; end <= all.length; end++) {
		assert.equal(tally.advance(window(all.slice(Math.max(0, end - 3), end), all[end - 4]?.id)), true);
		assert.equal(tally.stats.contextTokens, estimateContextTokens(contextOf(all.slice(0, end)).messages).tokens);
	}
	// The latest response's usage, also a failed one, as the cost line shows it.
	assert.deepEqual(tally.stats.latestAssistantUsage, usage(0));
	// A view without new entries changes nothing.
	const before = tally.stats;
	assert.equal(tally.advance(window(all.slice(-2), 7)), true);
	assert.deepEqual(tally.stats, before);
});

test("a compaction, a reset, an edit or skipped entries need a whole context", () => {
	const base = [entry(1, user("q")), entry(2, answer("a", 100))];
	const fresh = () => {
		const tally = new ContextTally();
		tally.reset(contextOf(base));
		return tally;
	};
	assert.equal(fresh().advance(window([...base, entry(3, user("s"), { head: 1 as EntryId })])), false);
	assert.equal(
		fresh().advance(window([...base, entry(3, undefined, { edits: [{ target: 1, action: "omit" }] } as never)])),
		false,
	);
	// Entries between the newest taken and the window's start were never seen.
	assert.equal(fresh().advance(window([entry(9, user("later"))], 8)), false);
	assert.equal(fresh().advance(window([entry(3, user("next"))], 2)), true);
});
