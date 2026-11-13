// Tests of host data operations on a live host (decision "Documents and table rows can belong to a host"; spec
// `docs/host-keyed/spec.md` §5): the gate between operations and activations' load phases; an import or delete reaching
// the live objects that hold the address's data (pinned and resident keys, live queries) in one batch, waiting for
// their transactions (owners of tables without slots or queries too); cancellation before admission writing nothing;
// an owner that cannot read an imported document failing alone; older tables migrated through their owner's history,
// newer ones refused; a host without a store refusing.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import { arr, int, keyed, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { HostDataGate } from "../../src/host/host-data.ts";
import { createHost, defineFacet, type FacetHost, type Host, type Reference } from "../../src/host/index.ts";
import type { ArchivePart } from "../../src/store/archive.ts";
import { eq, host, query } from "../../src/store/index.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { evolveTable } from "../../src/store/table-evolve.ts";
import { delivered, framesOf, holdNextCommit, loaded, memoryStore, rejection, Session } from "../support.ts";

const Meta = defineState("meta", {
	schema: obj({ title: str() }),
	version: 1,
	initial: () => ({ title: "" }),
	keyed: Session,
	persist: true,
	checkpointWhen: () => false,
});

/** `Meta` at version 2: an archive of it cannot be read by version 1's code. */
const MetaV2 = defineState("meta", {
	schema: obj({ title: str() }),
	version: 2,
	initial: () => ({ title: "" }),
	migrate: (old) => old as { title: string },
	keyed: Session,
	persist: true,
	checkpointWhen: () => false,
});

const Labels = defineTable("labels", {
	version: 1,
	columns: { session: host(Session), label: str() },
	key: ["session", "label"],
});

/** `Labels` at version 2: a color per label, set by a `rows` step. */
const LabelsV2 = evolveTable(Labels, (t) =>
	t.add("color", str({ default: "none" })).rows((row) => ({ color: row.label === "a" ? "blue" : "red" })),
);

const Row = obj({ session: obj({ kind: str(), params: obj({ id: str() }), key: str() }), label: str() });

/** S1's title and labels as live members and a derive over both; any session's title read on demand. */
const Board = local("test.board", {
	version: 1,
	params: {},
	members: {
		meta: obj({ title: str() }),
		metas: keyed(obj({ title: str() }), Session),
		labels: arr(Row),
		summary: str(),
		write: method(obj({ id: str(), title: str(), labels: arr(str()) })),
		title: method(str(), str()),
	},
});

/** One session's title as the board holds it: a view activated on demand (it has params). */
const View = local("test.view", { version: 1, params: { id: str() }, members: { meta: obj({ title: str() }) } });

/** The board's owner name with version 2 of its table: its labels' colors. */
const BoardV2 = local("test.board", {
	version: 1,
	params: {},
	members: { colors: method(str(), arr(str())) },
});

/** Entries of sessions in a table only: no host-keyed document, no live query. */
const Ledger = local("test.ledger", {
	version: 1,
	params: {},
	members: { put: method(str()), twice: method(str(), arr(int())), count: method(str(), int()) },
});

const Entries = defineTable("entries", {
	version: 1,
	columns: { session: host(Session), n: int() },
	key: ["session", "n"],
});

const S1 = Session({ id: "S1" });

/** Where `Ledger.twice` waits between its two reads (its transaction holds the ledger's line meanwhile). */
let between: Promise<void> = Promise.resolve();

/**
 * The facet setup serving `Board` (with `meta` at `metaDefinition`, its labels at `labels`) and `Ledger`: a reload
 * takes it again with another table version.
 */
function setup(
	metaDefinition: typeof Meta | typeof MetaV2 = Meta,
	labelsDefinition: typeof Labels | typeof LabelsV2 = Labels,
) {
	return (facet: FacetHost): void => {
		facet.serve(Board, (_, self) => {
			const meta = self.state(metaDefinition as typeof Meta);
			// Version 2 adds a defaulted column only: version 1's puts and queries fit both.
			const labels = self.table(labelsDefinition as typeof Labels);
			const pinned = meta.at(S1);
			const rows = self.query(
				labels,
				query(labelsDefinition as typeof Labels).where((t) => eq(t.session, S1)),
				10,
			);
			return {
				meta: pinned,
				metas: meta,
				labels: rows,
				summary: self.derive([pinned, rows], ([m, r]) => `${m.title}:${r.length}`),
				write: async ({ id, title, labels: names }, ctx) => {
					await self.tx(async (tx) => {
						(await tx.draft(meta, Session({ id }))).title = title;
						for (const label of names) tx.put(labels, { session: Session({ id }), label });
					}, ctx);
					return null;
				},
				title: async (id, ctx) => (await meta.get(Session({ id }), ctx))?.title ?? "",
			};
		});
		facet.serve(View, ({ id }, self) => ({ meta: self.get(Board, {}).metas.at(Session({ id })) }));
		facet.serve(Ledger, (_, self) => {
			const entries = self.table(Entries);
			const count = async (id: string, ctx: Parameters<typeof entries.count>[1]) =>
				entries.count(
					query(Entries).where((t) => eq(t.session, Session({ id }))),
					ctx,
				);
			return {
				put: async (id, ctx) => {
					await self.tx(async (tx) => tx.put(entries, { session: Session({ id }), n: 1 }), ctx);
					return null;
				},
				twice: async (id, ctx) =>
					self.tx(async (tx) => {
						const key = { session: Session({ id }), n: 1 };
						const first = (await tx.get(entries, key))?.n ?? 0;
						await between;
						const second = (await tx.get(entries, key))?.n ?? 0;
						return [first, second];
					}, ctx),
				count,
			};
		});
	};
}

/** A host serving `setup(metaDefinition)` on `store`, its errors; nothing activated yet. */
function served(store: ChordStore, metaDefinition: typeof Meta | typeof MetaV2 = Meta) {
	return loaded(setup(metaDefinition), { store });
}

/** A host serving `setup(metaDefinition)` on `store`, references to the board and the ledger. */
async function board(store: ChordStore, metaDefinition: typeof Meta | typeof MetaV2 = Meta) {
	const { host: h, errors } = await served(store, metaDefinition);
	return { host: h, board: await h.get(Board, {}, context), ledger: await h.get(Ledger, {}, context), errors };
}

/** Holds the ledger's line in a transaction until the returned release (an operation waits for it, exclusive). */
async function holdLedger(ledger: Reference<typeof Ledger>): Promise<() => Promise<void>> {
	const gate = Promise.withResolvers<void>();
	between = gate.promise;
	const reads = ledger.twice("S1", context);
	await delivered();
	return async () => {
		gate.resolve();
		await reads;
		between = Promise.resolve();
	};
}

/** The parts of `h`'s export of S1. */
async function exportedS1(h: Host): Promise<ArchivePart[]> {
	const parts: ArchivePart[] = [];
	for await (const part of h.exportHostData(S1, context)) parts.push(part);
	return parts;
}

/** S1's data from another store: title "one", labels a and b, one ledger entry. */
async function archiveOfS1(metaDefinition: typeof Meta | typeof MetaV2 = Meta): Promise<ArchivePart[]> {
	const source = await board(await memoryStore(), metaDefinition);
	await source.board.write({ id: "S1", title: "one", labels: ["a", "b"] }, context);
	await source.ledger.put("S1", context);
	const parts = await exportedS1(source.host);
	await source.host.close(context);
	return parts;
}

describe("live owners", () => {
	it("follow an import: a pinned key and a live query show the imported data, a resident key reads it", async () => {
		const parts = await archiveOfS1();
		const { host: h, board: live } = await board(await memoryStore());
		await live.write({ id: "S1", title: "old", labels: ["z"] }, context);
		await live.write({ id: "S2", title: "old two", labels: [] }, context);
		expect(await live.title("S2", context)).toBe("old two");
		expect(live.meta.value).toEqual({ title: "old" });
		await h.importHostData(parts, context, { existing: "replace" });
		expect(live.meta.value).toEqual({ title: "one" });
		expect(live.labels.value.map((row) => row.label)).toEqual(["a", "b"]);
		expect(live.labels.value[0]!.session).toEqual(S1);
		// A copy under S2 replaces the resident S2 document: the next read is the imported one.
		await h.importHostData(parts, context, { address: Session({ id: "S2" }), existing: "replace" });
		expect(await live.title("S2", context)).toBe("one");
		await h.close(context);
	});

	it("adopt every source in one batch: a derive over a document and a query sees one frame, never a torn state", async () => {
		const parts = await archiveOfS1();
		const { host: h, board: live } = await board(await memoryStore());
		await live.write({ id: "S1", title: "old", labels: ["z"] }, context);
		const frames = framesOf(await live.summary.watch(context));
		await h.importHostData(parts, context, { existing: "replace" });
		await delivered();
		// One frame from "old:1" to "one:2": no "one:1" or "old:2" in between.
		expect(frames.map(([value]) => value)).toEqual(["one:2"]);
		await h.close(context);
	});

	it("follow a delete: the pinned key reads initial(), the live query is empty", async () => {
		const { host: h, board: live } = await board(await memoryStore());
		await live.write({ id: "S1", title: "one", labels: ["a"] }, context);
		expect(await h.deleteHostData(S1, context)).toEqual({ documents: 1, rows: 1 });
		expect(live.meta.value).toEqual({ title: "" });
		expect(live.labels.value).toEqual([]);
		await h.close(context);
	});

	it("wait for a transaction of a table's owner without slots or queries: its two reads see the same row", async () => {
		const { host: h, ledger } = await board(await memoryStore());
		await ledger.put("S1", context);
		const gate = Promise.withResolvers<void>();
		between = gate.promise;
		const reads = ledger.twice("S1", context);
		await delivered();
		let deleted = false;
		const deleting = h.deleteHostData(S1, context).then(() => {
			deleted = true;
		});
		await delivered();
		expect(deleted).toBe(false);
		gate.resolve();
		expect(await reads).toEqual([1, 1]);
		await deleting;
		expect(await ledger.count("S1", context)).toBe(0);
		between = Promise.resolve();
		await h.close(context);
	});
});

describe("lifecycle", () => {
	it("an abort before the commit was admitted writes nothing", async () => {
		const store = await memoryStore();
		const { host: h, ledger } = await board(store);
		await ledger.put("S1", context);
		const gate = Promise.withResolvers<void>();
		between = gate.promise;
		const reads = ledger.twice("S1", context);
		await delivered();
		const { context: cancellable, cancel } = withCancel(context);
		const deleting = h.deleteHostData(S1, cancellable);
		await delivered();
		const seq = store.lastSeq;
		cancel(new Error("given up"));
		expect(await rejection(deleting)).toMatchObject({ message: "given up" });
		gate.resolve();
		await reads;
		between = Promise.resolve();
		expect(store.lastSeq).toBe(seq);
		expect(await ledger.count("S1", context)).toBe(1);
		await h.close(context);
	});

	it("an owner that cannot read an imported document fails alone; the other owners adopt", async () => {
		const parts = await archiveOfS1(MetaV2);
		const store = await memoryStore();
		const { host: h, ledger, errors } = await board(store);
		await h.importHostData(parts, context);
		await delivered();
		expect(errors.map((error) => [error.kind, "object" in error ? error.object : undefined])).toContainEqual([
			"object_failed",
			"test.board",
		]);
		expect(await ledger.count("S1", context)).toBe(1);
		await h.close(context);
	});

	it("a host without a store refuses every host data call", async () => {
		const h = createHost({ onError: () => {} });
		await h.load([], context);
		const refused = { code: "invalid", reason: "args", message: "deleteHostData: the host has no store" };
		expect(await rejection(h.deleteHostData(S1, context))).toMatchObject(refused);
		expect(() => h.exportHostData(S1, context)).toThrow("exportHostData: the host has no store");
		expect(await rejection(h.importHostData([], context))).toMatchObject({
			message: "importHostData: the host has no store",
		});
		await h.close(context);
	});
});

describe("older and newer tables", () => {
	/** A host serving `BoardV2` (the board's owner with `LabelsV2`) on `store`. */
	async function boardV2(store: ChordStore) {
		const { host: h } = await loaded(
			(facet) =>
				facet.serve(BoardV2, (_, self) => {
					const labels = self.table(LabelsV2);
					return {
						colors: async (id, ctx) =>
							(
								await labels.page(
									query(LabelsV2).where((t) => eq(t.session, Session({ id }))),
									10,
									ctx,
								)
							).items.map((row) => `${row.label}=${row.color}`),
					};
				}),
			{ store },
		);
		return h;
	}

	it("an older table's rows migrate through the owner's history (its owner activated for it)", async () => {
		const parts = await archiveOfS1();
		const store = await memoryStore();
		const first = await boardV2(store);
		await first.close(context);
		// The owner is not live: the import activates it to read its history.
		const h = await boardV2(store);
		await h.importHostData(parts, context);
		const colors = await h.get(BoardV2, {}, context);
		expect(await colors.colors("S1", context)).toEqual(["a=blue", "b=red"]);
		await h.close(context);
	});

	it("a newer table in the archive is refused", async () => {
		const parts = (await archiveOfS1()).map((part) =>
			part.kind === "table" && part.table === "test.board:labels" ? { ...part, version: 2 } : part,
		);
		const { host: h } = await board(await memoryStore());
		expect(await rejection(h.importHostData(parts, context))).toMatchObject({
			message: expect.stringContaining("at version 2 in the archive, newer than 1 here"),
		});
		await h.close(context);
	});
});

describe("the gate", () => {
	it("keeps load phases out while an operation is exclusive, and an operation waits for load phases under way", async () => {
		const gate = new HostDataGate();
		const order: string[] = [];
		const loading = Promise.withResolvers<void>();
		const holding = Promise.withResolvers<void>();
		const load = async (body: () => Promise<void>): Promise<void> => {
			await gate.enter();
			try {
				await body();
			} finally {
				gate.leave();
			}
		};
		const first = load(async () => {
			order.push("load 1");
			await loading.promise;
			order.push("load 1 done");
		});
		const operating = gate.turn(async (exclusive) => {
			order.push("turn");
			await exclusive(async () => {
				order.push("exclusive");
				await holding.promise;
				order.push("exclusive done");
			});
		}, context);
		await delivered();
		const second = load(async () => {
			order.push("load 2");
		});
		loading.resolve();
		await first;
		await delivered();
		expect(order).toEqual(["load 1", "turn", "load 1 done", "exclusive"]);
		holding.resolve();
		await operating;
		await second;
		expect(order).toEqual(["load 1", "turn", "load 1 done", "exclusive", "exclusive done", "load 2"]);
	});

	it("an operation given up while waiting for its turn passes the turn on", async () => {
		const gate = new HostDataGate();
		const running = Promise.withResolvers<void>();
		const first = gate.turn((exclusive) => exclusive(() => running.promise), context);
		const { context: cancellable, cancel } = withCancel(context);
		const second = gate.turn(async () => "second", cancellable);
		const third = gate.turn(async () => "third", context);
		cancel(new Error("given up"));
		expect(await rejection(second)).toMatchObject({ message: "given up" });
		running.resolve();
		await first;
		expect(await third).toBe("third");
	});
});

describe("review round 3", () => {
	it("an activation during an import (a view pinning the board's key) waits and reads what the import committed", async () => {
		const parts = await archiveOfS1();
		const { host: h } = await served(await memoryStore());
		const ledger = await h.get(Ledger, {}, context);
		const release = await holdLedger(ledger);
		const importing = h.importHostData(parts, context);
		await delivered();
		let activated = false;
		const getting = h.get(View, { id: "S1" }, context).then((live) => {
			activated = true;
			return live;
		});
		await delivered();
		await delivered();
		expect(activated).toBe(false);
		await release();
		await importing;
		const view = await getting;
		expect(view.meta.value).toEqual({ title: "one" });
		await h.close(context);
	});

	it("a reload during an import: the successor loads after it; a queued import sees the table its successor migrated", async () => {
		const parts = await archiveOfS1();
		const { host: h, board: live, ledger } = await board(await memoryStore());
		const release = await holdLedger(ledger);
		// An earlier operation holds the gate; the import queues behind it, the reload's successors wait at the gate.
		const deleting = h.deleteHostData(Session({ id: "S9" }), context);
		await delivered();
		const importing = h.importHostData(parts, context);
		const reloading = h.reload([{ name: "@test/app", facet: defineFacet(setup(Meta, LabelsV2)) }], context);
		await delivered();
		await release();
		await deleting;
		await reloading;
		await importing;
		await delivered();
		expect(live.meta.value).toEqual({ title: "one" });
		const colors = live.labels.value.map((row) => `${row.label}=${(row as { color?: string }).color}`);
		expect(colors).toEqual(["a=blue", "b=red"]);
		await h.close(context);
	});

	it("a cancellation after the commit was admitted changes nothing: it commits and is adopted", async () => {
		const store = await memoryStore();
		const { host: h, board: live } = await board(store);
		await live.write({ id: "S1", title: "one", labels: ["a"] }, context);
		const held = holdNextCommit(store);
		const { context: cancellable, cancel } = withCancel(context);
		const deleting = h.deleteHostData(S1, cancellable);
		await held.entered;
		cancel(new Error("too late"));
		held.release();
		expect(await deleting).toEqual({ documents: 1, rows: 1 });
		expect(live.meta.value).toEqual({ title: "" });
		expect(live.labels.value).toEqual([]);
		await h.close(context);
	});

	it("releases the owners it activated however the import ends (here refused: the owner declares no such table)", async () => {
		const parts = await archiveOfS1();
		const store = await memoryStore();
		// The store records the board's labels at version 2; the board served now declares no table.
		const first = await loaded(setup(Meta, LabelsV2), { store });
		await first.host.get(Board, {}, context);
		await first.host.close(context);
		const { host: h } = await loaded((facet) => facet.serve(BoardV2, () => ({ colors: async () => [] })), { store });
		const references = h.references(BoardV2);
		expect(await rejection(h.importHostData(parts, context))).toMatchObject({
			message: "importHostData: test.board is not served here to migrate its tables",
		});
		expect(references.value).toEqual([]);
		await h.close(context);
	});
});
