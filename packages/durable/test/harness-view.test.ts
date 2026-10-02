import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	type ConversationView,
	defineDoc,
	type Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

type Frame = { value: ConversationView; ops: readonly Op[] };

const MOUNTED = ["pi.agent", "pi.inbox", "pi.live", "pi.usage"];

/** Start a watch of `conversation` that records its acquisition revision and every delivered frame. */
async function record(conversation: Conversation) {
	const watch = await conversation.watch(context);
	const initial = watch.value;
	const frames: Frame[] = [];
	watch.start(async (value, ops) => {
		frames.push({ value, ops });
	});
	return { initial, frames, stop: () => watch.stop() };
}

/** A freshly built view of `conversation`, for comparing with an advanced one. */
async function fresh(conversation: Conversation): Promise<ConversationView> {
	const state = await conversation.viewState(context);
	const value = state.value;
	state.dispose();
	return value;
}

/** The view as committed state defines it, read without any mount: the active entries and the built-in documents. */
async function committed(harness: Harness, conversation: Conversation, record: ConversationView["conversation"]) {
	const docs: Record<string, unknown> = {};
	for (const token of [AgentDoc, LiveDoc, InboxDoc, UsageDoc] as const) {
		const value = await harness.snapshot(token as typeof LiveDoc, conversation.id, context);
		if (value !== undefined) docs[token.definition.kind] = value;
	}
	return { conversation: record, entries: (await conversation.context(context)).entries, docs };
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
	harness.subscribeCommits((publication) => {
		const touched = publication.changes.some(
			(change) =>
				(change.type === "entry" && change.value.conversationId === conversation.id) ||
				(change.type === "document" &&
					change.conversationId === conversation.id &&
					MOUNTED.includes(change.record.kind) &&
					change.ops.length > 0),
		);
		if (touched) counter.count++;
	});
	return counter;
}

describe("conversation view", () => {
	it("hydrates the active entries and the built-in documents", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([answer("hello")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		const view = await fresh(root);
		expect(view.conversation).toEqual({ id: root.id });
		expect(view.entries).toEqual(await allEntries(root));
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
		expect(replay(initial, frames)).toEqual(await committed(harness, root, initial.conversation));
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

	it("cuts the entries at a head marker, keeping the entries from its head", async () => {
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
		expect(kinds).toEqual([["summary", "b", "c"], ["summary", "b", "c", "d"], ["pi.reset"]]);
		expect(frames[0]!.ops).toEqual([["p", ["entries"], 0, 1, [summary]]]);
		expect(replay(initial, frames)).toEqual(await committed(harness, root, initial.conversation));
		await stop();
		await harness.close(context);
	});

	it("keeps only mounted entries for a raw head write that targets before the active range", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const old = await root.commit((tx) => tx.appendEntry(root.id, { kind: "old" }), context);
		await root.reset(undefined, context);
		const { frames, stop } = await record(root);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "summary", head: old.id }), context);
		await drained();
		// Model context now starts at `old` again, but the mount never held it (spec §12); a rebuilt mount shows it.
		expect(frames[0]!.value.entries.map((entry) => entry.kind)).toEqual(["summary"]);
		await stop();
		expect((await fresh(root)).entries.map((entry) => entry.kind)).toEqual(["summary", "old"]);
		await harness.close(context);
	});

	it("cuts a fork's view into its inherited entries", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const a = await root.commit((tx) => tx.appendEntry(root.id, { kind: "a" }), context);
		const b = await root.commit((tx) => tx.appendEntry(root.id, { kind: "b" }), context);
		const fork = await root.fork(b.id, { ownership: { kind: "ownerless" } }, context);
		const { initial, frames, stop } = await record(fork);
		await fork.commit((tx) => tx.appendEntry(fork.id, { kind: "summary", head: b.id }), context);
		await drained();
		expect(initial.entries.map((entry) => entry.id)).toEqual([a.id, b.id]);
		expect(frames[0]!.value.entries.map((entry) => entry.kind)).toEqual(["summary", "b"]);
		expect(frames[0]!.value).toEqual(await committed(harness, fork, initial.conversation));
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

	it("replaces undelivered frames with the newest view after 100 pending frames", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const watch = await root.watch(context);
		for (let index = 0; index < 101; index++) {
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		}
		const frames: Frame[] = [];
		watch.start(async (value, ops) => {
			frames.push({ value, ops });
		});
		await drained();
		expect(frames).toHaveLength(1);
		expect(frames[0]!.ops).toEqual([["r", frames[0]!.value]]);
		expect(frames[0]!.value.entries).toHaveLength(101);
		await watch.stop();
		await harness.close(context);
	});

	it("keeps states and watches of one conversation independent and remounts after the last one detaches", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const state = await root.viewState(context);
		const { frames, stop } = await record(root);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "one" }), context);
		await drained();
		expect(state.value.entries.map((entry) => entry.kind)).toEqual(["one"]);
		await stop();
		expect(frames).toHaveLength(1);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "two" }), context);
		await drained();
		expect(state.value.entries.map((entry) => entry.kind)).toEqual(["one", "two"]);
		const last = state.value;
		state.dispose();
		// No observer is left, so the mount was dropped: a new observer builds a new revision from committed state.
		const rebuilt = await fresh(root);
		expect(rebuilt).toEqual(last);
		expect(rebuilt).not.toBe(last);
		await harness.close(context);
	});

	it("ends states and watches at close and rejects later acquisition", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const watch = await root.watch(context);
		const state = await root.viewState(context);
		await harness.close(context);
		expect(await watch.closed).toEqual({ reason: "session_closed" });
		expect(state.value.entries).toEqual([]);
		await expect(root.watch(context)).rejects.toThrow();
		await expect(root.viewState(context)).rejects.toThrow();
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
		const shared = await root.viewState(context);
		expect(failing.value).toBe(shared.value);
		shared.dispose();
		failing.start(async () => {
			throw new Error("listener failed");
		});
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "one" }), context);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "two" }), context);
		await drained();
		expect(await failing.closed).toMatchObject({ reason: "listener_error" });
		expect(frames).toHaveLength(2);
		await stop();
		await harness.close(context);
	});

	it("publishes one frame for a commit that appends several entries and edits a document", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const Other = defineDoc<{ n: number }>({
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
		expect(replay(initial, frames)).toEqual(await committed(harness, root, initial.conversation));
		await stop();
		await harness.close(context);
	});
});
