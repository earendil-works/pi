// Tests for `ConversationTranscript`, the client-side layer that merges view windows into one transcript (#11327).
import {
	ConversationTranscript,
	type ConversationView,
	type Cursor,
	type EntryId,
	type EntryLoader,
	type EntryRecord,
	MemoryStorage,
	type TranscriptItem,
	type TranscriptView,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { context, onValue } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const CONVERSATION = { id: 1 } as unknown as ConversationView["conversation"];

/** Entries with IDs that have holes: every third ID is missing. */
function transcript(count: number): EntryRecord[] {
	const entries: EntryRecord[] = [];
	for (let id = 1; entries.length < count; id++) {
		if (id % 3 !== 0) entries.push({ id, conversationId: CONVERSATION.id, kind: "note" } as unknown as EntryRecord);
	}
	return entries;
}

/** A loader over `entries` with `Conversation.entries()` semantics, counting its calls. */
function loader(entries: readonly EntryRecord[]): EntryLoader & { calls: number } {
	const load = async (query: Parameters<EntryLoader>[0], limit: number) => {
		load.calls++;
		const matching = entries.filter(
			(entry) =>
				(query.minEntryId === undefined || entry.id >= query.minEntryId) &&
				(query.maxEntryId === undefined || entry.id <= query.maxEntryId),
		);
		const ordered = query.order === "ascending" ? matching : [...matching].reverse();
		const items = ordered.slice(0, limit);
		return { items, ...(ordered.length > limit ? { next: "more" as unknown as Cursor } : {}) };
	};
	load.calls = 0;
	return load;
}

/** The view of a window: `entries` with the entry before them in `all`. */
function windowOf(
	all: readonly EntryRecord[],
	first: number,
	last: number,
	docs: ConversationView["docs"] = {},
): ConversationView {
	const before = all[first - 1]?.id;
	return {
		conversation: CONVERSATION,
		entries: all.slice(first, last + 1),
		...(before === undefined ? {} : { before }),
		docs,
	};
}

/** Items as a compact list: entry IDs, `gap after..upTo`, and `earlier`. */
function shape(view: TranscriptView): (number | string)[] {
	return view.items.map((item) =>
		item.kind === "entry" ? item.entry.id : item.kind === "gap" ? `gap ${item.after}..${item.upTo}` : "earlier",
	);
}

const idsOf = (entries: readonly EntryRecord[]) => entries.map((entry) => entry.id);
const gapOf = (view: TranscriptView) =>
	view.items.find((item): item is Extract<TranscriptItem, { kind: "gap" }> => item.kind === "gap")!;

describe("ConversationTranscript", () => {
	it("shows a first window under an `earlier` marker, or alone when it starts the transcript", () => {
		const all = transcript(20);
		const later = new ConversationTranscript(loader(all));
		expect(shape(later.merge(windowOf(all, 15, 19)))).toEqual(["earlier", ...idsOf(all.slice(15))]);
		expect(later.newest).toBe(all[19]!.id);
		const whole = new ConversationTranscript(loader(all));
		expect(shape(whole.merge(windowOf(all, 0, 19)))).toEqual(idsOf(all));
	});

	it("appends, keeps entries the window dropped, and returns the same items when nothing is added", () => {
		const all = transcript(30);
		const helper = new ConversationTranscript(loader(all));
		const docsA = { a: { n: 1 } };
		const first = helper.merge(windowOf(all, 10, 19, docsA));
		const grown = helper.merge(windowOf(all, 10, 21, docsA));
		expect(shape(grown)).toEqual(["earlier", ...idsOf(all.slice(10, 22))]);
		// The window dropped its oldest; the transcript keeps them.
		const spliced = helper.merge(windowOf(all, 18, 21, docsA));
		expect(spliced.items).toBe(grown.items);
		expect(spliced).toBe(grown);
		// A docs-only change: a new view, the same items.
		const docs = { a: { n: 2 } };
		const streamed = helper.merge({ ...windowOf(all, 18, 21), docs });
		expect(streamed).not.toBe(grown);
		expect(streamed.items).toBe(grown.items);
		expect(streamed.docs).toBe(docs);
		expect(first.items).not.toBe(grown.items);
	});

	it("opens a gap when a window does not continue the transcript, and fills it page by page", async () => {
		const all = transcript(200);
		const load = loader(all);
		const helper = new ConversationTranscript(load, { pageSize: 50 });
		helper.merge(windowOf(all, 150, 159));
		// A stall: the next window starts well past the newest entry held.
		const stalled = helper.merge(windowOf(all, 190, 199));
		const gap = gapOf(stalled);
		expect(gap).toEqual({ kind: "gap", after: all[159]!.id, upTo: all[190]!.id });
		expect(shape(stalled)).toEqual([
			"earlier",
			...idsOf(all.slice(150, 160)),
			`gap ${all[159]!.id}..${all[190]!.id}`,
			...idsOf(all.slice(190)),
		]);
		// 30 entries are missing; one page loads them all and closes the gap.
		const filled = await helper.fillGap(gap, context);
		expect(shape(filled)).toEqual(["earlier", ...idsOf(all.slice(150))]);
		expect(load.calls).toBe(1);
	});

	it("shrinks a gap from its start while more than a page is missing", async () => {
		const all = transcript(200);
		const helper = new ConversationTranscript(loader(all), { pageSize: 10 });
		helper.merge(windowOf(all, 100, 109));
		let view = helper.merge(windowOf(all, 190, 199));
		view = await helper.fillGap(gapOf(view), context);
		expect(gapOf(view)).toEqual({ kind: "gap", after: all[119]!.id, upTo: all[190]!.id });
		while (view.items.some((item) => item.kind === "gap")) view = await helper.fillGap(gapOf(view), context);
		expect(shape(view)).toEqual(["earlier", ...idsOf(all.slice(100))]);
	});

	it("loads earlier pages until the start, then drops the marker", async () => {
		const all = transcript(45);
		const load = loader(all);
		const helper = new ConversationTranscript(load, { pageSize: 20 });
		helper.merge(windowOf(all, 40, 44));
		let view = await helper.loadEarlier(context);
		expect(shape(view)).toEqual(["earlier", ...idsOf(all.slice(20))]);
		// A page without a next cursor reaches the start.
		view = await helper.loadEarlier(context);
		expect(shape(view)).toEqual(idsOf(all));
		const calls = load.calls;
		expect(await helper.loadEarlier(context)).toBe(view);
		expect(load.calls).toBe(calls);
	});

	it("shares one load between concurrent calls of loadEarlier, and of fillGap for one gap", async () => {
		const all = transcript(100);
		const inner = loader(all);
		const gate = deferred();
		const load: EntryLoader = async (query, limit, callContext) => {
			await gate.promise;
			return inner(query, limit, callContext);
		};
		const helper = new ConversationTranscript(load);
		helper.merge(windowOf(all, 40, 49));
		const stalled = helper.merge(windowOf(all, 90, 99));
		const earlier = [helper.loadEarlier(context), helper.loadEarlier(context)];
		const fills = [helper.fillGap(gapOf(stalled), context), helper.fillGap(gapOf(stalled), context)];
		expect(earlier[0]).toBe(earlier[1]);
		expect(fills[0]).toBe(fills[1]);
		gate.resolve();
		await Promise.all([...earlier, ...fills]);
		expect(inner.calls).toBe(2);
		expect(shape(await helper.loadEarlier(context))).toEqual(idsOf(all));
	});

	it("resumes after `newest`: an empty window right after it adds nothing; one past it opens a gap", () => {
		const all = transcript(30);
		const helper = new ConversationTranscript(loader(all));
		const view = helper.merge(windowOf(all, 10, 19));
		const resumed: ConversationView = { conversation: CONVERSATION, entries: [], before: helper.newest!, docs: {} };
		expect(helper.merge(resumed).items).toBe(view.items);
		// A window that is empty but starts past `newest`: the entries up to its `before` are missing.
		const past = helper.merge({ ...resumed, before: all[25]!.id });
		expect(shape(past).at(-1)).toBe(`gap ${all[19]!.id}..${all[25]!.id + 1}`);
		expect(helper.newest).toBe(all[25]!.id);
		// The next window continues it.
		expect(shape(helper.merge(windowOf(all, 26, 27))).slice(-3)).toEqual([
			`gap ${all[19]!.id}..${all[25]!.id + 1}`,
			all[26]!.id,
			all[27]!.id,
		]);
	});

	it("fills a gap from a window that covers it", () => {
		const all = transcript(100);
		const helper = new ConversationTranscript(loader(all));
		helper.merge(windowOf(all, 40, 49));
		helper.merge(windowOf(all, 90, 99));
		// A wider window, such as a new watch with a larger `max`, covers the second half of the gap.
		const view = helper.merge(windowOf(all, 70, 99));
		expect(shape(view)).toEqual([
			"earlier",
			...idsOf(all.slice(40, 50)),
			`gap ${all[49]!.id}..${all[70]!.id}`,
			...idsOf(all.slice(70)),
		]);
	});

	it("rejects loadEarlier before the first merge and returns the view for a gap that is gone", async () => {
		const all = transcript(10);
		const helper = new ConversationTranscript(loader(all));
		await expect(helper.loadEarlier(context)).rejects.toThrow("merge a view first");
		const view = helper.merge(windowOf(all, 0, 9));
		const stale = { kind: "gap", after: 1 as EntryId, upTo: 2 as EntryId } as const;
		expect(await helper.fillGap(stale, context)).toBe(view);
	});
});

describe("ConversationTranscript loads", () => {
	it("retries a load whose loader threw synchronously, for loadEarlier and fillGap", async () => {
		const all = transcript(100);
		const inner = loader(all);
		let offline = true;
		let calls = 0;
		const load: EntryLoader = (query, limit, callContext) => {
			calls++;
			// An adapter that checks its connection before it returns a promise.
			if (offline) throw new Error("temporarily offline");
			return inner(query, limit, callContext);
		};
		const helper = new ConversationTranscript(load);
		helper.merge(windowOf(all, 40, 49));
		const stalled = helper.merge(windowOf(all, 90, 99));
		await expect(helper.loadEarlier(context)).rejects.toThrow("temporarily offline");
		await expect(helper.fillGap(gapOf(stalled), context)).rejects.toThrow("temporarily offline");
		offline = false;
		expect(shape(await helper.loadEarlier(context))).toEqual([
			...idsOf(all.slice(0, 50)),
			`gap ${all[49]!.id}..${all[90]!.id}`,
			...idsOf(all.slice(90)),
		]);
		expect(shape(await helper.fillGap(gapOf(stalled), context))).toEqual(idsOf(all));
		expect(calls).toBe(4);
	});

	it("retries a load that rejected", async () => {
		const all = transcript(30);
		const inner = loader(all);
		let fail = true;
		const load: EntryLoader = async (query, limit, callContext) => {
			if (fail) throw new Error("timeout");
			return inner(query, limit, callContext);
		};
		const helper = new ConversationTranscript(load);
		helper.merge(windowOf(all, 20, 29));
		await expect(helper.loadEarlier(context)).rejects.toThrow("timeout");
		fail = false;
		expect(shape(await helper.loadEarlier(context))).toEqual(idsOf(all));
	});

	it("keeps one gap for an empty window whose `before` lies inside it", () => {
		const all = transcript(100);
		const helper = new ConversationTranscript(loader(all));
		helper.merge(windowOf(all, 40, 49));
		const before = helper.merge(windowOf(all, 90, 99));
		const view = helper.merge({ conversation: CONVERSATION, entries: [], before: all[65]!.id, docs: before.docs });
		expect(view.items).toBe(before.items);
		expect(view.items.filter((item) => item.kind === "gap")).toHaveLength(1);
	});

	it("shares one load between a stale gap descriptor and the gap it shrank into", async () => {
		const all = transcript(100);
		const inner = loader(all);
		const gate = deferred();
		const load: EntryLoader = async (query, limit, callContext) => {
			await gate.promise;
			return inner(query, limit, callContext);
		};
		const helper = new ConversationTranscript(load, { pageSize: 10 });
		helper.merge(windowOf(all, 10, 19));
		const stale = gapOf(helper.merge(windowOf(all, 90, 99)));
		gate.resolve();
		const current = gapOf(await helper.fillGap(stale, context));
		expect(current).not.toEqual(stale);
		const loads = inner.calls;
		const [a, b] = [helper.fillGap(stale, context), helper.fillGap(current, context)];
		expect(a).toBe(b);
		await a;
		expect(inner.calls).toBe(loads + 1);
	});

	it("treats an empty page with a next cursor as the end of the range", async () => {
		const all = transcript(60);
		// A remote loader that always returns a cursor.
		const inner = loader(all);
		const load: EntryLoader = async (query, limit, callContext) => ({
			...(await inner(query, limit, callContext)),
			next: "more" as unknown as Cursor,
		});
		const helper = new ConversationTranscript(load, { pageSize: 100 });
		helper.merge(windowOf(all, 10, 19));
		let view = helper.merge(windowOf(all, 40, 49));
		view = await helper.fillGap(gapOf(view), context);
		// The first page held every missing entry; the next one is empty and closes the gap.
		view = await helper.fillGap(gapOf(view), context);
		expect(gapOf(view)).toBeUndefined();
		await helper.loadEarlier(context);
		view = await helper.loadEarlier(context);
		expect(shape(view)).toEqual(idsOf(all.slice(0, 50)));
	});

	it("resumes with `resume`: undefined before a merge, `{}` for an empty transcript, `{ from }` after the newest", () => {
		const all = transcript(30);
		const helper = new ConversationTranscript(loader(all));
		expect(helper.resume).toBeUndefined();
		helper.merge({ conversation: CONVERSATION, entries: [], docs: {} });
		expect(helper.resume).toEqual({});
		helper.merge(windowOf(all, 0, 9));
		expect(helper.resume).toEqual({ from: all[9]!.id + 1 });
	});
});

describe("ConversationTranscript over a Harness", () => {
	it("follows the walkthrough: live appends, a stall, fillGap, loadEarlier, and a resume with `from`", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const note = () => root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		for (let index = 0; index < 120; index++) await note();
		const helper = new ConversationTranscript((query, limit, callContext) =>
			root.entries(query, limit, undefined, callContext),
		);
		const window = { min: 10, max: 20 };
		const watch = await root.watch(context, window);
		let view = helper.merge(watch.value);
		watch.start(
			onValue(async ({ value }) => {
				view = helper.merge(value);
			}),
		);
		for (let index = 0; index < 15; index++) await note();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(view.items.some((item) => item.kind === "gap")).toBe(false);
		expect(view.items.filter((item) => item.kind === "entry")).toHaveLength(25);
		// A drop: the client misses 40 entries, more than `max`, and resumes after the newest it has.
		await watch.stop();
		for (let index = 0; index < 40; index++) await note();
		const resumed = await root.watch(context, { ...window, ...helper.resume });
		view = helper.merge(resumed.value);
		expect(view.items.filter((item) => item.kind === "gap")).toHaveLength(1);
		while (view.items.some((item) => item.kind === "gap")) view = await helper.fillGap(gapOf(view), context);
		while (view.items[0]?.kind === "earlier") view = await helper.loadEarlier(context);
		const entries = view.items.flatMap((item) => (item.kind === "entry" ? [item.entry.id] : []));
		expect(entries).toEqual(idsOf(await allEntries(root)));
		// A short drop resumes without a gap.
		for (let index = 0; index < 3; index++) await note();
		const again = await root.watch(context, { ...window, ...helper.resume });
		expect(again.value.entries).toHaveLength(3);
		view = helper.merge(again.value);
		expect(view.items.some((item) => item.kind !== "entry")).toBe(false);
		await resumed.stop();
		await again.stop();
		await harness.close(context);
	});
});
