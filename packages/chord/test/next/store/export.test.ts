// Tests of `store.export(ctx)` (slice 6a §13, rule 26): the parts in archive order, lossless; the commit queue held
// from the first `next()` until the export ends, is closed or aborts (also while the consumer is suspended); GC of
// closed and aborted iterators and their abort listeners.

import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { int, str } from "../../../src/next/contracts/index.ts";
import { ARCHIVE_FORMAT } from "../../../src/next/store/archive.ts";
import { insertDocument, insertRevision } from "../../../src/next/store/engine.ts";
import { EXPORT_PAGE } from "../../../src/next/store/export.ts";
import { STORE_SCHEMA } from "../../../src/next/store/schema.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import {
	archiveStore,
	expectCollected,
	exported,
	flushed,
	memoryStore,
	rejection,
	settledHeap,
	tableIn,
} from "../support.ts";

const OPEN = { admit: () => true, adopt: () => {} };

let store: ChordStore;
afterEach(async () => {
	await store?.close(context);
});

describe("parts", () => {
	it("come in archive order: manifest, per table its table write, puts and indexes, each record and its revisions, end", async () => {
		store = await archiveStore();
		const parts = await exported(store);
		expect(parts[0]).toEqual({
			kind: "manifest",
			format: ARCHIVE_FORMAT,
			schema: STORE_SCHEMA,
			lastSeq: store.lastSeq,
			nextId: store.nextId,
		});
		const kinds = parts.map((part) =>
			part.kind === "put" || part.kind === "table" || part.kind === "index"
				? `${part.kind} ${part.table.split(":")[1]}`
				: part.kind,
		);
		const runs: [string, number][] = [];
		for (const kind of kinds) {
			const last = runs.at(-1);
			if (last?.[0] === kind) last[1]++;
			else runs.push([kind, 1]);
		}
		expect(runs).toEqual([
			["manifest", 1],
			["table edits", 1],
			["put edits", 150],
			["index edits", 1],
			["table notes", 1],
			["put notes", 150],
			["document.create", 1],
			["document.revision", 1],
			["document.create", 1],
			["document.revision", 3],
			["document.create", 1],
			["document.revision", 2],
			["end", 1],
		]);
		expect(parts.at(-1)).toEqual({ kind: "end", writes: parts.length - 2 });
	});

	it("are lossless: stored values and versions, NULL cells absent, a migrating table's state, revisions as stored", async () => {
		store = await archiveStore();
		const parts = await exported(store);
		const edits = parts.filter((part) => part.kind === "put" && part.table.endsWith(":edits"));
		expect(edits.slice(0, 2)).toEqual([
			{
				kind: "put",
				table: "app.store:edits",
				row: { id: "e000", path: "p/0", at: 0, note: "n0", meta: { a: 0 }, done: false },
				version: 1,
				columns: { meta: 1 },
			},
			{
				kind: "put",
				table: "app.store:edits",
				row: { id: "e001", path: "p/1", at: 1, done: false },
				version: 1,
				columns: {},
			},
		]);
		expect(parts.find((part) => part.kind === "table" && part.table.endsWith(":notes"))).toMatchObject({
			version: 2,
			state: "migrating",
		});
		const notes = parts.filter((part) => part.kind === "put" && part.table.endsWith(":notes"));
		expect(notes.map((part) => (part.kind === "put" ? part.version : 0)).filter((v) => v === 2)).toHaveLength(100);
		const documents = parts.flatMap((part): unknown[][] =>
			part.kind === "document.create"
				? [[part.record.key, part.record.revision, part.record.history]]
				: part.kind === "document.revision"
					? [[part.content.kind, part.content.kind === "base" ? part.content.value : part.content.ops]]
					: [],
		);
		expect(documents).toEqual([
			// A singleton's record has no key.
			[undefined, 1, "none"],
			["base", { title: "" }],
			["a", 3, "none"],
			["base", { title: "a" }],
			["delta", [["s", ["title"], "a2"]]],
			["delta", [["s", ["title"], "a3"]]],
			["b", 2, "none"],
			["base", { title: "b" }],
			["delta", [["s", ["title"], "b2"]]],
		]);
	});
});

describe("revisions", () => {
	it("a history longer than a page is read page by page and exported whole, in seq order", async () => {
		store = await memoryStore();
		const count = EXPORT_PAGE * 2 + 1;
		const record = {
			id: 2,
			owner: "app.store",
			namespace: "session",
			kind: "long",
			history: "rewindable" as const,
			createdAt: 1,
			revision: 1,
			version: 1,
			fingerprint: "",
		};
		const create: StagedWrite = {
			order: "write",
			apply: async (step) => {
				await insertDocument(step, record, "{}");
				return [];
			},
		};
		await store.commit([create], OPEN, context);
		for (let n = 1; n < count; n++) {
			const ops = JSON.stringify([["s", ["n"], n]]);
			const delta: StagedWrite = {
				order: "write",
				apply: async (step) => {
					await insertRevision(step, record.id, step.seq, "delta", 1, ops);
					return [];
				},
			};
			await store.commit([delta], OPEN, context);
		}
		const revisions = (await exported(store)).flatMap((part) => (part.kind === "document.revision" ? [part] : []));
		expect(revisions.map(({ seq }) => seq)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
	});
});

describe("the commit queue", () => {
	it("is held from the first next() until the export ends: a commit waits", async () => {
		store = await archiveStore();
		const iterator = store.export(context);
		await iterator.next();
		let committed = false;
		const commit = store.commit([], OPEN, context).then(() => {
			committed = true;
		});
		await flushed();
		expect(committed).toBe(false);
		while (!(await iterator.next()).done) {}
		await commit;
		expect(committed).toBe(true);
	});

	it("is given back by return(); the closed iterator keeps nothing", async () => {
		store = await archiveStore();
		let iterator: AsyncIterableIterator<unknown> | undefined = store.export(context);
		await iterator.next();
		await iterator.next();
		await iterator.return!();
		await store.commit([], OPEN, context);
		const collected = new WeakRef(iterator);
		iterator = undefined;
		await expectCollected(collected);
	});

	it("is given back at once when ctx aborts while the consumer is suspended; a later next() rejects aborted", async () => {
		store = await archiveStore();
		const { context: cancellable, cancel } = withCancel(context);
		const iterator = store.export(cancellable);
		await iterator.next();
		const signal = cancellable.abortSignal!;
		expect(getEventListeners(signal, "abort")).toHaveLength(1);
		cancel(new Error("stop"));
		await store.commit([], OPEN, context);
		expect(getEventListeners(signal, "abort")).toHaveLength(0);
		expect(await rejection(iterator.next())).toMatchObject({ code: "aborted" });
	});

	it("a retained aborted iterator keeps no page", async () => {
		store = await memoryStore();
		const Big = defineTable("big", { version: 1, columns: { id: int(), text: str() }, key: ["id"] });
		const staged: StagedWrite[] = [];
		const changes = new TableChanges(await tableIn(store, Big), staged);
		for (let i = 0; i < EXPORT_PAGE; i++) changes.put({ id: i, text: `${i}`.padEnd(8_000, "x") });
		await store.commit(staged, OPEN, context);
		const { context: cancellable, cancel } = withCancel(context);
		const before = await settledHeap();
		const iterator = store.export(cancellable);
		// The manifest, the table write, and the first put of a page of 100 rows of 8 KB each.
		for (let i = 0; i < 3; i++) await iterator.next();
		cancel(new Error("stop"));
		const after = await settledHeap();
		expect(after - before).toBeLessThan(200 * 1024);
		expect(await rejection(iterator.next())).toMatchObject({ code: "aborted" });
	});

	it("code that commits while consuming its own export waits until ctx aborts", async () => {
		store = await archiveStore();
		const { context: cancellable, cancel } = withCancel(context);
		const iterator = store.export(cancellable);
		await iterator.next();
		const commit = store.commit([], OPEN, context);
		let committed = false;
		void commit.then(() => {
			committed = true;
		});
		await flushed();
		expect(committed).toBe(false);
		cancel(new Error("stop"));
		await commit;
		expect(committed).toBe(true);
	});

	it("closing the store ends a held export: its next() rejects released, also for a part that needs no read", async () => {
		store = await archiveStore();
		const iterator = store.export(context);
		await iterator.next();
		await store.close(context);
		// The table write would need no read.
		expect(await rejection(iterator.next())).toMatchObject({ code: "released" });
		expect(await rejection(iterator.next())).toMatchObject({ code: "released" });
	});

	it("an abort while next() waits for the queue rejects at once; no abort listener is left", async () => {
		store = await archiveStore();
		const first = store.export(context);
		await first.next();
		const { context: cancellable, cancel } = withCancel(context);
		const second = store.export(cancellable);
		const waiting = rejection(second.next());
		await flushed();
		cancel(new Error("stop"));
		expect(await waiting).toMatchObject({ code: "aborted" });
		expect(getEventListeners(cancellable.abortSignal!, "abort")).toHaveLength(0);
		// The first export still holds the queue; once it ends, the aborted one gives the queue back at once.
		await first.return!();
		await store.commit([], OPEN, context);
		expect(await rejection(second.next())).toMatchObject({ code: "aborted" });
	});

	it("closing the store before an export's first next() rejects it released: not even a manifest", async () => {
		store = await archiveStore();
		const iterator = store.export(context);
		await store.close(context);
		expect(await rejection(iterator.next())).toMatchObject({ code: "released" });
		expect(await rejection(iterator.next())).toMatchObject({ code: "released" });
	});

	it("closing the store while an export waits for the queue rejects its next() released", async () => {
		store = await archiveStore();
		const first = store.export(context);
		await first.next();
		const second = store.export(context);
		const waiting = rejection(second.next());
		await flushed();
		await store.close(context);
		expect(await waiting).toMatchObject({ code: "released" });
	});
});
