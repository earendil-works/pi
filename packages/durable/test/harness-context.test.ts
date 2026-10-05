import type { Message } from "@earendil-works/pi-ai";
import { type EntryDraft, type EntryId, type EntryRecord, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { assistant, describeMessage, openHarness, system, toolResult, user } from "./harness-support.ts";
import { context } from "./session-support.ts";

async function setup() {
	const { harness } = await openHarness(new MemoryStorage());
	const root = await harness.root(context);
	const append = (draft: EntryDraft): Promise<EntryRecord> =>
		root.commit((tx) => tx.appendEntry(root.id, draft), context);
	const message = (model: Message, kind = "message"): Promise<EntryRecord> => append({ kind, model: [model] });
	return { harness, root, append, message };
}

function ids(entries: readonly EntryRecord[]): EntryId[] {
	return entries.map((entry) => entry.id);
}

describe("conversation context", () => {
	it("returns the whole transcript without a head and excludes model-less entries from messages", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("hi"));
		const note = await append({ kind: "note", data: { text: "display only" } });
		const answer = await message(assistant("hello"));
		const view = await root.context(context);
		expect(view.head).toBeUndefined();
		expect(ids(view.entries)).toEqual([first.id, note.id, answer.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:hi", "assistant:hello"]);
	});

	it("returns the same context as a fork at each inclusive cutoff", async () => {
		const { harness, root, append, message } = await setup();
		const first = await message(user("first"));
		const edit = await append({
			kind: "edit",
			edits: [{ target: first.id, action: "replace", messages: [user("edited")] }],
		});
		const reset = await append({ kind: "reset", head: "self", model: [user("fresh")] });
		const kept = await message(assistant("kept"));
		const summary = await append({ kind: "summary", head: kept.id, model: [user("summary")] });
		await message(user("later"));

		for (const at of [first.id, edit.id, reset.id, kept.id, summary.id]) {
			const fork = await root.fork(at, { ownership: { kind: "ownerless" } }, context);
			expect(await root.context(context, at)).toEqual(await fork.context(context));
		}
		expect((await root.context(context, first.id)).messages.map(describeMessage)).toEqual(["user:first"]);
		expect((await root.context(context, edit.id)).messages.map(describeMessage)).toEqual(["user:edited"]);
		await harness.close(context);
	});

	it("accepts inherited cutoffs and rejects entries outside visible history", async () => {
		const { harness, root, message } = await setup();
		const inherited = await message(user("inherited"));
		const hidden = await message(user("hidden"));
		const child = await root.fork(inherited.id, { ownership: { kind: "ownerless" } }, context);
		const own = await child.commit((tx) => tx.appendEntry(child.id, { kind: "note" }), context);
		expect(await child.context(context, inherited.id)).toEqual(await root.context(context, inherited.id));
		await expect(child.context(context, hidden.id)).rejects.toThrow("not visible");
		await expect(root.context(context, own.id)).rejects.toThrow("not visible");
		await expect(root.context(context, 999999 as EntryId)).rejects.toThrow("not visible");
		await harness.close(context);
	});

	it("excludes aborted, error, and deferred assistant messages but keeps their raw entries", async () => {
		const { root, message } = await setup();
		await message(user("q"));
		const aborted = await message(assistant("partial", { stopReason: "aborted" }));
		await message(assistant("failed", { stopReason: "error" }));
		await message(assistant("later", { stopReason: "deferred" }));
		await message(assistant("done", { stopReason: "length" }));
		const view = await root.context(context);
		expect(view.entries).toHaveLength(5);
		expect(view.entries[1]!.id).toBe(aborted.id);
		expect(view.messages.map(describeMessage)).toEqual(["user:q", "assistant:done"]);
	});

	it("resolves self heads and uses the newest head marker", async () => {
		const { root, append, message } = await setup();
		await message(user("old"));
		const reset = await append({ kind: "reset", head: "self", model: [user("fresh start")] });
		expect(reset.head).toBe(reset.id);
		const after = await message(assistant("after reset"));
		let view = await root.context(context);
		expect(view.head?.id).toBe(reset.id);
		expect(ids(view.entries)).toEqual([reset.id, after.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:fresh start", "assistant:after reset"]);

		// A compaction summary heads an earlier kept entry; older head markers in range drop out.
		const summary = await append({ kind: "summary", head: after.id, model: [user("summary")] });
		const tail = await message(user("next"));
		view = await root.context(context);
		expect(view.head?.id).toBe(summary.id);
		expect(ids(view.entries)).toEqual([summary.id, after.id, tail.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:summary", "assistant:after reset", "user:next"]);
	});

	it("applies the newest edit per target within the active range", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("first"));
		const second = await message(user("second"));
		await append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first v2")] }] });
		await append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first v3")] }] });
		await append({ kind: "edit", edits: [{ target: second.id, action: "omit" }] });
		let view = await root.context(context);
		expect(view.entries).toHaveLength(5);
		expect(view.messages.map(describeMessage)).toEqual(["user:first v3"]);

		// Edits before the active range no longer apply.
		const reset = await append({ kind: "reset", head: second.id });
		view = await root.context(context);
		expect(view.head?.id).toBe(reset.id);
		expect(view.messages.map(describeMessage)).toEqual([]);
		await append({ kind: "edit", edits: [{ target: second.id, action: "replace", messages: [user("second v2")] }] });
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual(["user:second v2"]);
	});

	it("keeps positional system messages and orders tool results by call order", async () => {
		const { root, message, append } = await setup();
		await message(system({ preamble: "You help." }), "pi.system");
		await message(user("run tools"));
		await message(assistant("calling", { calls: ["b", "a"] }));
		await message(toolResult("a"));
		await append({ kind: "pi.system", model: [system({ cwd: "/repo" })] });
		await message(toolResult("b"));
		await message(toolResult("zz"));
		await message(assistant("done"));
		const view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:preamble",
			"user:run tools",
			"assistant:calling",
			"result:b:result b",
			"result:a:result a",
			"system:cwd",
			"assistant:done",
		]);
	});

	it("synthesizes missing tool results after a fork and drops results cut from their call", async () => {
		const { root, message } = await setup();
		await message(user("go"));
		const call = await message(assistant("calling", { calls: ["x", "y"] }));
		await message(toolResult("x"));
		const second = await message(toolResult("y"));
		const child = await root.fork(call.id, { ownership: { kind: "ownerless" } }, context);
		const childView = await child.context(context);
		expect(await root.context(context, call.id)).toEqual(childView);
		expect(childView.messages.map(describeMessage)).toEqual([
			"user:go",
			"assistant:calling",
			"result:x:error",
			"result:y:error",
		]);
		const missing = childView.messages[2]!;
		expect(missing).toMatchObject({
			role: "toolResult",
			toolName: "tool-x",
			details: { reason: "missing_result" },
		});

		// A head between a call and its results leaves stray results that are not sent.
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "reset", head: second.id }), context);
		const parentView = await root.context(context);
		expect(parentView.messages.map(describeMessage)).toEqual([]);
		expect(parentView.entries.map((entry) => entry.kind)).toEqual(["reset", "message"]);
	});
});
