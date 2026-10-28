import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	type ConversationView,
	type ConversationWindow,
	defineDoc,
	type EntryRecord,
	type Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	ProviderDoc,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { context, onValue } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

type Frame = { value: ConversationView; ops: readonly Op[] };

const MOUNTED = ["pi.agent", "pi.inbox", "pi.live", "pi.provider", "pi.usage"];

/** Start a watch of `conversation` that records its acquisition revision and every delivered frame. */
async function record(conversation: Conversation, window?: ConversationWindow) {
	const watch = await conversation.watch(context, window);
	const initial = watch.value;
	const frames: Frame[] = [];
	watch.start(
		onValue(async ({ value, ops }) => {
			frames.push({ value, ops });
		}),
	);
	return { initial, frames, stop: () => watch.stop() };
}

/** A freshly built view of `conversation`, for comparing with an advanced one. */
async function fresh(conversation: Conversation, window?: ConversationWindow): Promise<ConversationView> {
	const watch = await conversation.watch(context, window);
	const value = watch.value;
	await watch.stop();
	return value;
}

/**
 * The view as committed state defines it, read without any mount: the newest `size` entries, the entry before them, and
 * the built-in documents.
 */
async function committed(
	harness: Harness,
	conversation: Conversation,
	record: ConversationView["conversation"],
	size: number,
) {
	const docs: Record<string, unknown> = {};
	for (const token of [AgentDoc, LiveDoc, InboxDoc, ProviderDoc, UsageDoc] as const) {
		const value = await harness.snapshot(token as typeof LiveDoc, conversation.id, context);
		if (value !== undefined) docs[token.definition.kind] = value;
	}
	const newest = [...(await conversation.entries({}, size + 1, undefined, context)).items];
	const before = newest.length > size ? newest.pop()!.id : undefined;
	return { conversation: record, entries: newest.reverse(), ...(before === undefined ? {} : { before }), docs };
}

/** Replay every frame's operations from `initial`, checking each delivered revision on the way. */
function replay(initial: ConversationView, frames: readonly Frame[]): ConversationView {
	let value = initial;
	for (const frame of frames) {
		value = applyImmutable(value, frame.ops);
		expect(value).toEqual(frame.value);
	}
	return value;
}

function answer(text: string): AssistantMessage {
	return fauxAssistantMessage([fauxText(text)]);
}

/** Let watch callbacks, which run after the commit, catch up. */
async function drained(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function touches(harness: Harness, conversation: Conversation): { count: number } {
	const counter = { count: 0 };
	harness.observeCommits({
		advance: (publication) => {
			const touched = publication.changes.some(
				(change) =>
					(change.type === "entry" && change.value.conversationId === conversation.id) ||
					(change.type === "document" &&
						change.kind === "change" &&
						change.conversationId === conversation.id &&
						MOUNTED.includes(change.record.kind) &&
						change.ops.length > 0),
			);
			if (touched) counter.count++;
		},
		end: () => {},
	});
	return counter;
}

describe("conversation view", () => {
	it("hydrates the newest entries and the built-in documents", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([answer("hello")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		const view = await fresh(root);
		expect(view.conversation).toEqual({ id: root.id });
		expect(view.entries).toEqual(await allEntries(root));
		expect(view.before).toBeUndefined();
		expect(Object.keys(view.docs).sort()).toEqual(MOUNTED);
		expect(view.docs["pi.live"]).toEqual({});
		expect(view.docs["pi.inbox"]).toEqual({ items: [] });
		await harness.close(context);
	});

	it("publishes one frame per touching commit, whose operations rebuild every revision", async () => {
		const setup = chatSetup();
		const release = deferred();
		const step: FauxResponseStep = async (_request, options) => {
			await Promise.race([release.promise, aborted(options!.signal!)]);
			return answer("a longer answer");
		};
		setup.faux.setResponses([step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { initial, frames, stop } = await record(root);
		const touching = touches(harness, root);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(() => frames.some((frame) => (frame.value.docs["pi.live"] as { generation?: unknown }).generation));
		release.resolve();
		await submission.wait(context);
		await harness.waitForIdle(context);
		await drained();
		expect(frames).toHaveLength(touching.count);
		const last = replay(initial, frames);
		expect(last).toEqual(await committed(harness, root, initial.conversation, last.entries.length));
		expect(frames[0]!.ops).toContainEqual(["p", ["entries"], 0, 0, [expect.objectContaining({ kind: "pi.user" })]]);
		// Document operations keep their exact shape under the mount path.
		expect(frames.flatMap((frame) => frame.ops)).toContainEqual([
			"s",
			["docs", "pi.live", "generation"],
			{ attempt: 1 },
		]);
		await stop();
		await harness.close(context);
	});

	it("shares unchanged parts between revisions and skips commits that touch nothing mounted", async () => {
		const setup = chatSetup();
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const { initial, frames, stop } = await record(root);
		await other.commit((tx) => tx.appendEntry(other.id, { kind: "note" }), context);
		await root.configure({ thinkingLevel: "high" }, context);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await drained();
		expect(frames).toHaveLength(2);
		expect(frames[0]!.ops).toEqual([["s", ["docs", "pi.agent", "thinkingLevel"], "high"]]);
		expect(frames[0]!.value.entries).toBe(initial.entries);
		expect(frames[0]!.value.docs["pi.live"]).toBe(initial.docs["pi.live"]);
		expect(frames[1]!.value.docs).toBe(frames[0]!.value.docs);
		await stop();
		await harness.close(context);
	});

	it("keeps head markers in place: a summary and a reset are appended entries", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const note = (kind: string) => root.commit((tx) => tx.appendEntry(root.id, { kind }), context);
		await note("a");
		const b = await note("b");
		await note("c");
		const { initial, frames, stop } = await record(root);
		const summary = await root.commit((tx) => tx.appendEntry(root.id, { kind: "summary", head: b.id }), context);
		await note("d");
		await root.reset(undefined, context);
		await drained();
		const kinds = frames.map((frame) => frame.value.entries.map((entry) => entry.kind));
		expect(kinds).toEqual([
			["a", "b", "c", "summary"],
			["a", "b", "c", "summary", "d"],
			["a", "b", "c", "summary", "d", "pi.reset"],
		]);
		expect(frames[0]!.ops).toEqual([["p", ["entries"], 3, 0, [summary]]]);
		// The summary's `head` tells a renderer where the entries it summarizes end.
		expect(frames[0]!.value.entries[3]!.head).toBe(b.id);
		const last = replay(initial, frames);
		expect(last).toEqual(await committed(harness, root, initial.conversation, 6));
		await stop();
		await harness.close(context);
	});

	it("shows a fork's inherited entries in ID order, its head markers in place", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const a = await root.commit((tx) => tx.appendEntry(root.id, { kind: "a" }), context);
		const b = await root.commit((tx) => tx.appendEntry(root.id, { kind: "b" }), context);
		const fork = await root.fork(b.id, { ownership: { kind: "ownerless" } }, context);
		const { initial, frames, stop } = await record(fork);
		await fork.commit((tx) => tx.appendEntry(fork.id, { kind: "summary", head: b.id }), context);
		await drained();
		expect(initial.entries.map((entry) => entry.id)).toEqual([a.id, b.id]);
		expect(frames[0]!.value.entries.map((entry) => entry.kind)).toEqual(["a", "b", "summary"]);
		expect(frames[0]!.value).toEqual(await committed(harness, fork, initial.conversation, 3));
		await stop();
		await harness.close(context);
	});

	it("shows a fork's inherited entries and follows only the fork's own commits", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const first = await root.commit((tx) => tx.appendEntry(root.id, { kind: "first" }), context);
		const fork = await root.fork(first.id, { ownership: { kind: "ownerless" } }, context);
		const { initial, frames, stop } = await record(fork);
		expect(initial.entries.map((entry) => entry.kind)).toEqual(["first"]);
		expect(initial.conversation.parent).toEqual({ conversationId: root.id, at: first.id });
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "parent" }), context);
		await fork.commit((tx) => tx.appendEntry(fork.id, { kind: "child" }), context);
		await drained();
		expect(frames.map((frame) => frame.value.entries.map((entry) => entry.kind))).toEqual([["first", "child"]]);
		await stop();
		await harness.close(context);
	});

	it("unmounts a retired document and mounts its recreation whole", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const { frames, stop } = await record(root);
		await root.commit((tx) => tx.retireDoc(LiveDoc, root.id), context);
		await root.commit(async (tx) => {
			(await tx.doc(LiveDoc, root.id)).tools = [];
		}, context);
		await drained();
		expect(frames.map((frame) => frame.ops)).toEqual([
			[["d", ["docs", "pi.live"]]],
			[["s", ["docs", "pi.live"], { tools: [] }]],
		]);
		expect(frames[0]!.value.docs["pi.live"]).toBeUndefined();
		await stop();
		await harness.close(context);
	});

	it("folds undelivered commits into one call whose ops reach the newest view", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const watch = await root.watch(context);
		const initial = watch.value;
		for (let index = 0; index < 101; index++) {
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		}
		const frames: Frame[] = [];
		watch.start(
			onValue(async ({ value, ops }) => {
				frames.push({ value, ops });
			}),
		);
		await drained();
		expect(frames).toHaveLength(1);
		expect(frames[0]!.ops[0]?.[0]).not.toBe("r");
		expect(applyImmutable(initial, frames[0]!.ops)).toEqual(frames[0]!.value);
		// The default window took 100 appends, then dropped its oldest 51 at the 101st, down to 50.
		expect(frames[0]!.value).toEqual(await committed(harness, root, initial.conversation, 50));
		await watch.stop();
		await harness.close(context);
	});

	it("keeps watches of one conversation independent and remounts after the last one detaches", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const kept = await record(root);
		const { frames, stop } = await record(root);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "one" }), context);
		await drained();
		expect(kept.frames.at(-1)!.value.entries.map((entry) => entry.kind)).toEqual(["one"]);
		await stop();
		expect(frames).toHaveLength(1);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "two" }), context);
		await drained();
		const last = kept.frames.at(-1)!.value;
		expect(last.entries.map((entry) => entry.kind)).toEqual(["one", "two"]);
		await kept.stop();
		// No observer is left, so the mount was dropped: a new observer builds a new revision from committed state.
		const rebuilt = await fresh(root);
		expect(rebuilt).toEqual(last);
		expect(rebuilt).not.toBe(last);
		await harness.close(context);
	});

	it("ends watches at close and rejects later acquisition", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const watch = await root.watch(context);
		await harness.close(context);
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(watch.value.entries).toEqual([]);
		await expect(root.watch(context)).rejects.toThrow();
	});

	it("rejects an acquisition cancelled or closed while it waits for the Session line", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const hold = () => {
			const release = deferred();
			const blocking = root.commit(async () => {
				await release.promise;
			}, context);
			return { release: () => release.resolve(), blocking };
		};
		let held = hold();
		const controller = new AbortController();
		const cancelled = root.watch({ ...context, abortSignal: controller.signal });
		controller.abort(new Error("cancelled"));
		held.release();
		await held.blocking;
		await expect(cancelled).rejects.toThrow("cancelled");

		held = hold();
		const closedWhileQueued = root.watch(context);
		const closing = harness.close(context);
		held.release();
		await held.blocking;
		await expect(closedWhileQueued).rejects.toThrow("Harness is closed");
		await closing;
	});

	it("shares one mount between concurrent observers and isolates a failing listener", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const failing = await root.watch(context);
		const { frames, stop } = await record(root);
		const shared = await root.watch(context);
		// Each observer has its own window; the documents are the mount's.
		expect(failing.value).toEqual(shared.value);
		expect(failing.value.docs).toBe(shared.value.docs);
		await shared.stop();
		failing.start(async () => {
			throw new Error("listener failed");
		});
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "one" }), context);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "two" }), context);
		await drained();
		expect(await failing.closed).toMatchObject({ kind: "listener_error" });
		expect(frames).toHaveLength(2);
		await stop();
		await harness.close(context);
	});

	it("publishes one frame for a commit that appends several entries and edits a document", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const Other = defineDoc<{ n: number }>({
			checkpointWhen: () => false,
			kind: "app.other",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			initial: () => ({ n: 0 }),
		});
		const { initial, frames, stop } = await record(root);
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "a" });
			(await tx.doc(LiveDoc, root.id)).tools = [];
			await tx.appendEntry(root.id, { kind: "b" });
		}, context);
		// A document that is not mounted publishes nothing.
		await root.commit(async (tx) => {
			(await tx.doc(Other, root.id)).n = 1;
		}, context);
		await drained();
		expect(frames).toHaveLength(1);
		expect(frames[0]!.value.entries.map((entry) => entry.kind)).toEqual(["a", "b"]);
		expect(replay(initial, frames)).toEqual(await committed(harness, root, initial.conversation, 2));
		await stop();
		await harness.close(context);
	});
});

/** Append one entry of `kind` per commit; returns the entries. */
async function notes(conversation: Conversation, count: number, kind = "note"): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	for (let index = 0; index < count; index++) {
		entries.push(await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind, data: index }), context));
	}
	return entries;
}

const ids = (entries: readonly EntryRecord[]) => entries.map((entry) => entry.id);

const gc = (() => {
	setFlagsFromString("--expose-gc");
	return runInNewContext("gc") as () => void;
})();

describe("conversation view window", () => {
	it("starts with the newest `min` entries and the entry before them, or the whole short transcript", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const written = await notes(root, 10);
		const view = await fresh(root, { min: 4 });
		expect(ids(view.entries)).toEqual(ids(written.slice(6)));
		expect(view.before).toBe(written[5]!.id);
		// The default window: the newest 50, here all ten, starting the transcript.
		const all = await fresh(root);
		expect(ids(all.entries)).toEqual(ids(written));
		expect(all.before).toBeUndefined();
		expect("before" in all).toBe(false);
		await harness.close(context);
	});

	it("takes appends up to `max`, then drops its oldest in one splice down to `min`", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const written = await notes(root, 4);
		const { initial, frames, stop } = await record(root, { min: 3, max: 5 });
		expect(ids(initial.entries)).toEqual(ids(written.slice(1)));
		const appended = await notes(root, 3);
		await drained();
		expect(frames.map((frame) => frame.value.entries.length)).toEqual([4, 5, 3]);
		const [e5, e6, e7] = appended as [EntryRecord, EntryRecord, EntryRecord];
		expect(frames[0]!.ops).toEqual([["p", ["entries"], 3, 0, [e5]]]);
		expect(frames[2]!.ops).toEqual([
			["p", ["entries"], 5, 0, [e7]],
			["p", ["entries"], 0, 3, []],
			["s", ["before"], written[3]!.id],
		]);
		expect(ids(frames[2]!.value.entries)).toEqual(ids([e5, e6, e7]));
		expect(frames[2]!.value.before).toBe(written[3]!.id);
		const last = replay(initial, frames);
		expect(last).toEqual(await committed(harness, root, initial.conversation, 3));
		// Entries that stay keep their identity: a splice moves them, it never copies them.
		expect(frames[2]!.value.entries[0]).toBe(frames[1]!.value.entries[3]);
		await stop();
		await harness.close(context);
	});

	it("keeps the newest `min` of a commit that appends more than `max` at once", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		await notes(root, 2);
		const { initial, frames, stop } = await record(root, { min: 2, max: 3 });
		const burst = await root.commit(async (tx) => {
			const entries: EntryRecord[] = [];
			for (let index = 0; index < 5; index++) entries.push(await tx.appendEntry(root.id, { kind: "burst" }));
			return entries;
		}, context);
		await drained();
		expect(frames).toHaveLength(1);
		expect(ids(frames[0]!.value.entries)).toEqual(ids(burst.slice(3)));
		expect(frames[0]!.value.before).toBe(burst[2]!.id);
		expect(replay(initial, frames)).toEqual(await committed(harness, root, initial.conversation, 2));
		await stop();
		await harness.close(context);
	});

	it("starts at `from` when the entries since fit in `max`, otherwise at the newest `min`", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const written = await notes(root, 30);
		const window = { min: 5, max: 10 };
		// Ten entries since `from`: all of them, with the entry before `from`.
		const within = await fresh(root, { ...window, from: written[20]!.id });
		expect(ids(within.entries)).toEqual(ids(written.slice(20)));
		expect(within.before).toBe(written[19]!.id);
		// Fewer than `min` since `from`: only those.
		const short = await fresh(root, { ...window, from: written[28]!.id });
		expect(ids(short.entries)).toEqual(ids(written.slice(28)));
		expect(short.before).toBe(written[27]!.id);
		// Resuming after the newest entry: an empty window right after it.
		const resumed = await fresh(root, { ...window, from: (written[29]!.id + 1) as EntryRecord["id"] });
		expect(resumed.entries).toEqual([]);
		expect(resumed.before).toBe(written[29]!.id);
		// Eleven since `from`: more than `max`, so the newest `min`; `before` shows the client a gap.
		const beyond = await fresh(root, { ...window, from: written[19]!.id });
		expect(ids(beyond.entries)).toEqual(ids(written.slice(25)));
		expect(beyond.before).toBe(written[24]!.id);
		// From the transcript's start.
		const whole = await fresh(root, { min: 40, from: written[0]!.id });
		expect(ids(whole.entries)).toEqual(ids(written));
		expect(whole.before).toBeUndefined();
		await harness.close(context);
	});

	it("advances a resumed window by appends from its start", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const written = await notes(root, 5);
		const { initial, frames, stop } = await record(root, { from: (written[4]!.id + 1) as EntryRecord["id"] });
		const later = await notes(root, 2);
		await drained();
		expect(ids(frames.at(-1)!.value.entries)).toEqual(ids(later));
		expect(frames.at(-1)!.value.before).toBe(written[4]!.id);
		expect(replay(initial, frames)).toEqual(frames.at(-1)!.value);
		await stop();
		await harness.close(context);
	});

	it("uses `from` only for the first value: a `from` past the newest entry starts empty and takes every append", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const written = await notes(root, 3);
		const from = (written[2]!.id + 1000) as EntryRecord["id"];
		const { initial, frames, stop } = await record(root, { from });
		expect(initial.entries).toEqual([]);
		expect(initial.before).toBe(written[2]!.id);
		// An entry below `from` is still appended: the window continues from its attachment.
		const [next] = await notes(root, 1);
		expect(next!.id).toBeLessThan(from);
		await drained();
		expect(frames.at(-1)!.value.entries).toEqual([next]);
		expect(frames.at(-1)!.value.before).toBe(written[2]!.id);
		await stop();
		await harness.close(context);
	});

	it("rejects window bounds that are not integers or put `max` below `min`", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		await expect(root.watch(context, { min: 0 })).rejects.toThrow(RangeError);
		await expect(root.watch(context, { min: 1.5 })).rejects.toThrow(RangeError);
		await expect(root.watch(context, { min: 10, max: 9 })).rejects.toThrow(RangeError);
		await expect(root.watch(context, { from: Number.NaN as EntryRecord["id"] })).rejects.toThrow(RangeError);
		const recorder = { advance: () => {}, end: () => {} };
		await expect(harness.observeConversation(root.id, recorder, context, { max: 0 })).rejects.toThrow(RangeError);
		// `max` may equal `min`.
		await (await root.watch(context, { min: 3, max: 3 })).stop();
		await harness.close(context);
	});

	it("gives each observer its own window over one mount", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const written = await notes(root, 6);
		const changes: ConversationView[] = [];
		const observation = await harness.observeConversation(
			root.id,
			{ advance: (call) => call.kind === "value" && changes.push(call.value), end: () => {} },
			context,
			{ min: 2, max: 3 },
		);
		const wide = await record(root, { min: 5 });
		expect(ids(observation.value.entries)).toEqual(ids(written.slice(4)));
		expect(ids(wide.initial.entries)).toEqual(ids(written.slice(1)));
		const [next] = await notes(root, 1);
		await drained();
		expect(ids(changes[0]!.entries)).toEqual(ids([...written.slice(4), next!]));
		expect(ids(wide.frames[0]!.value.entries)).toEqual(ids([...written.slice(1), next!]));
		expect(changes[0]!.docs).toBe(wide.frames[0]!.value.docs);
		observation.detach();
		await wide.stop();
		await harness.close(context);
	});

	it("bounds an overflow replacement by `max`", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const watch = await root.watch(context, { min: 5, max: 6 });
		// Past 10,000 pending operations, the next call is one root replacement: here an append per commit, and a splice
		// and a `before` every other commit.
		for (let index = 0; index < 6000; index++) {
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		}
		const frames: Frame[] = [];
		watch.start(
			onValue(async ({ value, ops }) => {
				frames.push({ value, ops });
			}),
		);
		await drained();
		expect(frames).toHaveLength(1);
		expect(frames[0]!.ops).toEqual([["r", frames[0]!.value]]);
		expect(frames[0]!.value.entries.length).toBeLessThanOrEqual(6);
		await watch.stop();
		await harness.close(context);
	}, 30_000);

	it("lets a long-lived watch drop the entries that left its window", async () => {
		// On SQLite, which keeps no entry objects, so only the watch can hold the first one.
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-view-"));
		const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
		const { harness, root } = await openChat(storage, chatSetup());
		const watch = await root.watch(context, { min: 5, max: 10 });
		let first: WeakRef<EntryRecord> | undefined;
		let count = 0;
		watch.start(
			onValue(async ({ value }) => {
				count = value.entries.length;
				if (first === undefined && value.entries[0] !== undefined) first = new WeakRef(value.entries[0]);
			}),
		);
		await notes(root, 1);
		await waitFor(() => first !== undefined);
		await notes(root, 200);
		await drained();
		expect(count).toBeLessThanOrEqual(10);
		for (let round = 0; round < 3 && first!.deref() !== undefined; round++) {
			await drained();
			gc();
		}
		expect(first!.deref()).toBeUndefined();
		await watch.stop();
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	});
});
