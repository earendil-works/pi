// A viewed conversation's transcript (src/web/history.ts), shared by the web and the TUI chat view: Durable's
// `ConversationTranscript` over the window `Chat.view` holds, earlier pages and gaps through `Chat.entries`, a
// transcript kept on the device, and what is kept of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView, EntryId, EntryRecord, TranscriptView } from "@earendil-works/pi-durable";
import type { Watchable } from "@p2/app/v1";
import type { EntriesPage } from "../../plugins/chat/contract.ts";
import { type EntriesSource, type Gap, keptWindow, TranscriptStore } from "../../src/web/history.ts";
import { Browser, browserTests } from "./browser.ts";
import { startFixture } from "./helpers.ts";

const entry = (id: number): EntryRecord =>
	({ id: id as EntryId, conversationId: 1, kind: "p2.input", data: { n: id } }) as unknown as EntryRecord;
const view = (ids: readonly number[], before?: number): ConversationView =>
	({
		conversation: { id: 1 },
		entries: ids.map(entry),
		docs: {},
		...(before === undefined ? {} : { before }),
	}) as unknown as ConversationView;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const shown = (store: TranscriptStore): (number | string)[] =>
	(store.value?.view.items ?? []).map((item) =>
		item.kind === "entry" ? item.entry.id : item.kind === "gap" ? `gap ${item.after}-${item.upTo}` : "earlier",
	);

/**
 * A view watchable whose values the test sends, as Chord delivers them: `snapshot` as a whole value (a reconnect's
 * `r`), `ops` as a change of the last one. Values sent before the store's watch started wait for it.
 */
function liveView() {
	type Call = { kind: "value"; value: ConversationView; ops: unknown[]; retired: boolean };
	let listener: ((call: Call) => Promise<void>) | undefined;
	const waiting: Call[] = [];
	const send = (call: Call) => {
		if (listener) void listener(call);
		else waiting.push(call);
	};
	const readable = {
		value: undefined,
		watch: async () => ({
			value: undefined,
			start: (next: typeof listener) => {
				listener = next;
				for (const call of waiting.splice(0)) void next?.(call);
			},
			stop: async () => {
				listener = undefined;
				return { kind: "stopped" };
			},
			closed: new Promise(() => {}),
		}),
	} as unknown as Watchable<ConversationView | null | undefined>;
	/** Resolves once the store applied the call (its watch starts asynchronously). */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
	return {
		readable,
		snapshot: async (value: ConversationView) => {
			await settle();
			send({ kind: "value", value, ops: [["r", value]], retired: false });
			await settle();
		},
		ops: async (value: ConversationView) => {
			await settle();
			send({ kind: "value", value, ops: [], retired: false });
			await settle();
		},
	};
}

/** `Chat.entries` over the entries `all`, recording each query. */
function entriesOf(all: readonly number[]) {
	const queries: Parameters<EntriesSource>[0][] = [];
	const source: EntriesSource = async (query) => {
		queries.push(query);
		const matching = all.filter(
			(id) => id >= (query.minEntryId ?? Number.NEGATIVE_INFINITY) && id <= (query.maxEntryId ?? Infinity),
		);
		const ordered = query.order === "ascending" ? matching : matching.toReversed();
		return { items: ordered.slice(0, query.limit).map(entry), more: ordered.length > query.limit } as EntriesPage;
	};
	return { source, queries };
}

test("the window's entries stay as it moves; earlier pages load until the start", async () => {
	const live = liveView();
	const { source, queries } = entriesOf(range(1, 120));
	const store = new TranscriptStore({ view: live.readable, entries: source });
	const stop = store.subscribe(() => {});
	await live.snapshot(view(range(71, 100), 70));
	assert.deepEqual(shown(store), ["earlier", ...range(71, 100)]);
	// The window drops its oldest: they stay.
	await live.ops(view(range(101, 120), 100));
	assert.deepEqual(shown(store), ["earlier", ...range(71, 120)]);
	await store.loadEarlier();
	assert.deepEqual(queries[0], { maxEntryId: 70, order: "descending", limit: 100 });
	assert.deepEqual(shown(store), range(1, 120));
	// At the start nothing loads.
	await store.loadEarlier();
	assert.equal(queries.length, 1);
	stop();
});

test("a reconnect past what is held leaves a gap that fills page by page; reaching an entry loads through it", async () => {
	const live = liveView();
	const { source } = entriesOf(range(1, 300));
	const store = new TranscriptStore({ view: live.readable, entries: source });
	const stop = store.subscribe(() => {});
	await live.snapshot(view(range(1, 50)));
	// Much happened while disconnected: the new window starts past entry 50.
	await live.snapshot(view(range(251, 300), 250));
	assert.deepEqual(shown(store), [...range(1, 50), "gap 50-251", ...range(251, 300)]);
	assert.equal(await store.loadThrough(120), true);
	assert.ok(shown(store).includes(120));
	assert.equal(shown(store).filter((item) => typeof item === "string").length, 1, "the gap shrank");
	assert.equal(await store.loadThrough(1000), false);
	const gapOf = () => store.value?.view.items.find((item): item is Gap => item.kind === "gap");
	for (let gap = gapOf(); gap; gap = gapOf()) await store.fillGap(gap);
	assert.deepEqual(shown(store), range(1, 300));
	stop();
});

test("a transcript kept on the device shows first; a live view continuing it is merged in", async () => {
	const live = liveView();
	const store = new TranscriptStore({ view: live.readable, entries: entriesOf([]).source });
	const stop = store.subscribe(() => {});
	store.seed(view(range(1, 5)));
	assert.deepEqual(shown(store), range(1, 5));
	await live.snapshot(view(range(5, 7), 4));
	assert.deepEqual(shown(store), range(1, 7));
	stop();
});

test("a kept transcript the live view does not continue, or one newer than the server's, starts over", async () => {
	for (const [kept, window] of [
		// Much happened since: the window starts past anything kept.
		[view(range(1, 5)), view([40, 41], 39)],
		// The server was restored from an older backup and ends at 6.
		[view(range(1, 8)), view([5, 6], 4)],
		// An empty conversation on the server.
		[view(range(1, 3)), view([])],
	] as const) {
		const live = liveView();
		const store = new TranscriptStore({ view: live.readable, entries: entriesOf([]).source });
		const stop = store.subscribe(() => {});
		store.seed(kept);
		await live.snapshot(window);
		assert.deepEqual(
			shown(store),
			window.before === undefined
				? window.entries.map((item) => item.id)
				: ["earlier", ...window.entries.map((item) => item.id)],
		);
		// A seed after the first view changes nothing.
		store.seed(view([1]));
		assert.equal(shown(store)[0], window.before === undefined ? window.entries[0]?.id : "earlier");
		stop();
	}
});

test("what is kept: the newest entries without a gap, within the byte budget, and where they start", async () => {
	const items = (ids: readonly (number | "gap" | "earlier")[]): TranscriptView =>
		({
			conversation: { id: 1 },
			docs: {},
			items: ids.map((id) =>
				id === "gap"
					? { kind: "gap", after: 10, upTo: 20 }
					: id === "earlier"
						? { kind: "earlier" }
						: { kind: "entry", entry: entry(id) },
			),
		}) as unknown as TranscriptView;
	const ids = (value: ConversationView) => [value.before, value.entries.map((item) => item.id)];
	assert.deepEqual(ids(keptWindow(items([1, 2, 3]), 1_000_000)), [undefined, [1, 2, 3]]);
	assert.deepEqual(ids(keptWindow(items(["earlier", 5, 6]), 1_000_000)), [4, [5, 6]]);
	assert.deepEqual(ids(keptWindow(items([1, 2, "gap", 20, 21]), 1_000_000)), [19, [20, 21]]);
	const size = JSON.stringify(entry(1)).length;
	assert.deepEqual(ids(keptWindow(items([1, 2, 3]), size * 2)), [1, [2, 3]]);
	// At least one entry.
	assert.deepEqual(ids(keptWindow(items([1, 2, 3]), 1)), [2, [3]]);
});

test(
	"a gap's row loads its entries once shown and on a tap, styled as the top edge",
	{ skip: !browserTests, timeout: 60_000 },
	async () => {
		const fixture = await startFixture({ web: true });
		let browser: Browser | undefined;
		try {
			browser = await Browser.start();
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}`);
			await browser.wait("document.querySelector('.app')");
			await browser.loadFixture("gap-row.ts");
			await browser.wait("typeof window.showGap==='function'");
			const answer = (id: number) => ({
				kind: "entry",
				entry: {
					id,
					conversationId: 1,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "text", text: `answer ${id}` }],
							stopReason: "stop",
							timestamp: id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					],
				},
			});
			const view = {
				conversation: { id: 1 },
				docs: {},
				items: [answer(1), answer(2), { kind: "gap", after: 2, upTo: 9 }, answer(9)],
			};
			await browser.evaluate(`window.showGap(${JSON.stringify(view)}, false)`);
			await browser.wait("document.querySelector('button.history-edge.earlier')?.textContent==='Load more'");
			// Rendered, it asks once.
			await browser.wait("window.filled.length===1");
			assert.deepEqual(await browser.evaluate("window.filled"), ["2-9"]);
			await browser.evaluate("document.querySelector('button.history-edge.earlier').click()");
			assert.deepEqual(await browser.evaluate("window.filled"), ["2-9", "2-9"]);
			// While it loads it is disabled and shows the spinner, as the top edge does.
			await browser.evaluate(`window.showGap(${JSON.stringify(view)}, true)`);
			await browser.wait("document.querySelector('button.history-edge.earlier.loading')?.disabled===true");
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);
