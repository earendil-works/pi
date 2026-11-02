// Tests of `importStore` (slice 6a §13, rules 12, 24, 25): round trips (old row versions, a migrating table,
// uncheckpointed deltas), the store it returns, every refusal of the archive's order and content, the rollback, and an
// input that stalls cancelled by `ctx`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import type { JsonValue } from "../../../src/json.ts";
import { nul, obj, opt, str } from "../../../src/next/contracts/index.ts";
import type { ArchivePart } from "../../../src/next/store/archive.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import { findDocument, loadDocument } from "../../../src/next/store/engine.ts";
import { importStore } from "../../../src/next/store/import.ts";
import { json } from "../../../src/next/store/json-column.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";
import { TableHandle } from "../../../src/next/store/table-handle.ts";
import { prepareTables } from "../../../src/next/store/table-migration.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { ArchiveTables, archiveStore, exported, memoryStore, rejection, tableIn, tableOwner } from "../support.ts";

const stores: ChordStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close(context);
});

/** `parts` imported into a fresh `:memory:` backend. */
async function imported(parts: Iterable<unknown> | AsyncIterable<unknown>, outbox?: boolean): Promise<ChordStore> {
	const backend = sqliteBackend(await openNodeSqliteDatabase(":memory:"));
	const store = (await importStore(backend, parts, context, { outbox })) as ChordStore;
	stores.push(store);
	return store;
}

/** The archive of `archiveStore`. */
async function archive(): Promise<ArchivePart[]> {
	const source = await archiveStore();
	stores.push(source);
	return exported(source);
}

describe("round trips", () => {
	it("an imported archive exports the same parts: lossless, at the manifest's lastSeq and next document id", async () => {
		const parts = await archive();
		const store = await imported(parts);
		expect(await exported(store)).toEqual(parts);
		const manifest = parts[0] as Extract<ArchivePart, { readonly kind: "manifest" }>;
		expect([store.lastSeq, store.nextId]).toEqual([manifest.lastSeq, manifest.nextId]);
	});

	it("the store keeps its ids, seqs and folded documents; the outbox, when asked, starts after lastSeq", async () => {
		const parts = await archive();
		const store = await imported(parts, true);
		expect(await store.outbox!.read(store.lastSeq, 10, context)).toEqual([]);
		expect(await rejection(store.outbox!.read(0, 10, context))).toMatchObject({ code: "invalid" });
		const record = await store.read(
			(executor) => findDocument(executor, { namespace: "chord", owner: "app.store", kind: "memo", key: "a" }),
			context,
		);
		const original = parts.find((part) => part.kind === "document.create" && part.record.key === "a");
		expect(record).toEqual((original as Extract<ArchivePart, { readonly kind: "document.create" }>).record);
		expect((await store.read((executor) => loadDocument(executor, record!), context)).value).toEqual({ title: "a3" });
	});

	it("a migrating table resumes on the imported store; rows written at version 1 read as the table's", async () => {
		const store = await imported(await archive());
		const { EditsV2, NotesV2 } = ArchiveTables;
		const notes = "app.store:notes";
		const fence = { admit: () => true, adopt: () => {} };
		await expect(
			prepareTables([{ definition: NotesV2, table: notes }], store, fence, "app", context),
		).rejects.toThrow("crash");
		const edits = new TableHandle(EditsV2, "app.store:edits", store, tableOwner());
		expect(await edits.get({ id: "e003" }, context)).toEqual({
			id: "e003",
			path: "p/3",
			at: 3,
			meta: { a: 3 },
			done: false,
		});
	});
});

describe("json(...) cells holding null", () => {
	it("a JSON null round-trips, required and optional, put and updated; an absent optional cell stays absent", async () => {
		const source = await memoryStore();
		stores.push(source);
		const Cells = defineTable("cells", {
			version: 1,
			columns: { id: str(), data: json(nul(), { version: 1 }), more: opt(json(nul(), { version: 1 })) },
			key: ["id"],
		});
		const handle = await tableIn(source, Cells);
		const staged: StagedWrite[] = [];
		const changes = new TableChanges(handle, staged);
		changes.put({ id: "a", data: null, more: null });
		changes.put({ id: "b", data: null });
		changes.put({ id: "c", data: null, more: null });
		changes.update({ id: "c" }, { more: undefined });
		await source.commit(staged, { admit: () => true, adopt: () => {} }, context);
		const rows = [
			{ id: "a", data: null, more: null },
			{ id: "b", data: null },
			{ id: "c", data: null },
		];
		for (const row of rows) expect(await handle.get({ id: row.id }, context)).toEqual(row);
		const parts = await exported(source);
		const store = await imported(parts);
		expect(await exported(store)).toEqual(parts);
		const copy = new TableHandle(Cells, handle.sql.table, store, tableOwner());
		for (const row of rows) expect(await copy.get({ id: row.id }, context)).toEqual(row);
	});

	it("a JSON null at an older cell version round-trips with its version and migrates on access in the copy", async () => {
		const source = await memoryStore();
		stores.push(source);
		const V1 = defineTable("cells", {
			version: 1,
			columns: { id: str(), data: json(nul(), { version: 1 }) },
			key: ["id"],
		});
		const old = await tableIn(source, V1);
		const staged: StagedWrite[] = [];
		new TableChanges(old, staged).put({ id: "a", data: null });
		await source.commit(staged, { admit: () => true, adopt: () => {} }, context);
		const V2 = evolveTable(V1, (t) =>
			t.json("data", json(obj({ was: nul() }), { version: 2, migrate: (value) => ({ was: value as null }) })),
		);
		const handle = await tableIn(source, V2);
		expect(await handle.get({ id: "a" }, context)).toEqual({ id: "a", data: { was: null } });
		const parts = await exported(source);
		expect(parts.find((part) => (part as ArchivePart).kind === "put")).toMatchObject({
			row: { id: "a", data: null },
			columns: { data: 1 },
		});
		const store = await imported(parts);
		expect(await exported(store)).toEqual(parts);
		const copy = new TableHandle(V2, handle.sql.table, store, tableOwner());
		expect(await copy.get({ id: "a" }, context)).toEqual({ id: "a", data: { was: null } });
	});
});

/** The archive with `edit` applied to a copy of its parts. */
async function edited(edit: (parts: ArchivePart[]) => unknown[]): Promise<unknown[]> {
	return edit(structuredClone(await archive()));
}

/** The index of the first part of `kind` (and table suffix). */
function first(parts: readonly ArchivePart[], kind: ArchivePart["kind"], table?: string): number {
	return parts.findIndex(
		(part) => part.kind === kind && (table === undefined || ("table" in part && part.table.endsWith(table))),
	);
}

interface Mutable {
	[field: string]: JsonValue | Mutable;
}

/** Part `index` as a writable object. */
/** The positions of every part of `kind`. */
function all(parts: readonly ArchivePart[], kind: ArchivePart["kind"]): number[] {
	return parts.flatMap((part, index) => (part.kind === kind ? [index] : []));
}

function at(parts: unknown[], index: number): Mutable {
	return parts[index] as Mutable;
}

/** The content of the revision part at `index`, writable. */
function revisionContent(parts: unknown[], index: number): Mutable {
	return at(parts, index).content as Mutable;
}

describe("refusals", () => {
	it.each<[string, (parts: ArchivePart[]) => unknown[], string]>([
		[
			"a part outside the schema",
			(parts) => [...parts.slice(0, 1), { kind: "put" }, ...parts.slice(1)],
			"not an archive part",
		],
		["no manifest first", (parts) => parts.slice(1), "the manifest comes first"],
		["a second manifest", (parts) => [parts[0], ...parts], "the manifest comes first, once"],
		[
			"another format",
			(parts) => {
				at(parts, 0).format = 2;
				return parts;
			},
			"format 2 is not 1",
		],
		[
			"a newer store schema",
			(parts) => {
				at(parts, 0).schema = 9;
				return parts;
			},
			"schema 9 is newer",
		],
		[
			"a lastSeq of 2^53 (a later seq would repeat)",
			(parts) => {
				at(parts, 0).lastSeq = 2 ** 53;
				return parts;
			},
			"part 0: not an archive part",
		],
		[
			"a document revision beyond 2^53 - 1",
			(parts) => {
				const record = at(parts, first(parts, "document.create")).record as Mutable;
				record.revision = 2 ** 53;
				return parts;
			},
			"not an archive part",
		],
		["a part after the end", (parts) => [...parts, { kind: "end", writes: 0 }], "after the end"],
		["no end", (parts) => parts.slice(0, -1), "has no end part"],
		[
			"a wrong end count",
			(parts) => {
				at(parts, parts.length - 1).writes = 1;
				return parts;
			},
			"counts 1 writes",
		],
		[
			"a put before its table",
			(parts) => {
				const put = first(parts, "put", ":notes");
				return [...parts.slice(0, first(parts, "table")), parts[put], ...parts.slice(first(parts, "table"))];
			},
			"a put follows its table's table write",
		],
		[
			"a put after its table's indexes",
			(parts) => {
				const index = first(parts, "index");
				return [...parts.slice(0, index + 1), parts[index - 1], ...parts.slice(index + 1)];
			},
			"a put follows its table's table write, before its indexes",
		],
		[
			"a table twice",
			(parts) => {
				const table = first(parts, "table", ":notes");
				return [...parts.slice(0, table), parts[first(parts, "table")], ...parts.slice(table)];
			},
			"occurs twice",
		],
		[
			"a table after the documents",
			(parts) => {
				const table = first(parts, "table", ":notes");
				const documents = first(parts, "document.create");
				return [
					...parts.slice(0, table),
					...parts.slice(documents, -1),
					...parts.slice(table, documents),
					parts.at(-1),
				];
			},
			"tables come before the documents",
		],
		[
			"a table name that is not owner:table",
			(parts) => {
				at(parts, first(parts, "table")).table = "edits";
				return parts;
			},
			"not owner:table",
		],
		[
			"a column name breaking the rules",
			(parts) => {
				const table = at(parts, first(parts, "table"));
				table.columns = { ...(table.columns as Mutable), "bad name": { type: "str", optional: true } };
				return parts;
			},
			"not a column name",
		],
		[
			"a row with an unknown column",
			(parts) => {
				(at(parts, first(parts, "put")).row as Mutable).extra = 1;
				return parts;
			},
			'unknown column "extra"',
		],
		[
			"a row without a non-opt column",
			(parts) => {
				delete (at(parts, first(parts, "put")).row as Mutable).path;
				return parts;
			},
			'column "path" is missing',
		],
		[
			"a value of another type",
			(parts) => {
				(at(parts, first(parts, "put")).row as Mutable).at = "x";
				return parts;
			},
			"is not a int value",
		],
		[
			"a json(...) cell newer than its column",
			(parts) => {
				(at(parts, first(parts, "put")).columns as Mutable).meta = 5;
				return parts;
			},
			"no readable version",
		],
		[
			"a row newer than its table",
			(parts) => {
				at(parts, first(parts, "put")).version = 7;
				return parts;
			},
			"version 7 is newer",
		],
		[
			"an id not below the manifest's next id",
			(parts) => {
				(at(parts, first(parts, "document.create")).record as Mutable).id = 10_000;
				return parts;
			},
			"is not below",
		],
		[
			"an id twice",
			(parts) => {
				const [one, two] = all(parts, "document.create");
				(at(parts, two!).record as Mutable).id = (at(parts, one!).record as Mutable).id!;
				return parts;
			},
			"occurs twice",
		],
		[
			"a record created after lastSeq",
			(parts) => {
				(at(parts, first(parts, "document.create")).record as Mutable).createdAt = 10_000;
				return parts;
			},
			"a lifetime outside the manifest's lastSeq",
		],
		[
			"a base at another version than its record's",
			(parts) => {
				revisionContent(parts, first(parts, "document.revision")).version = 2;
				return parts;
			},
			"has no base at its version",
		],
		[
			"a delta without a base at its version",
			(parts) => {
				const delta = parts.findIndex((part) => part.kind === "document.revision" && part.content.kind === "delta");
				revisionContent(parts, delta).version = 2;
				return parts;
			},
			"a delta without a base at its version",
		],
		[
			"a revision out of seq order",
			(parts) => {
				const delta = parts.findIndex((part) => part.kind === "document.revision" && part.content.kind === "delta");
				at(parts, delta).seq = 1;
				return parts;
			},
			"out of seq order",
		],
		[
			"a revision of another record",
			(parts) => {
				at(parts, first(parts, "document.revision")).id = 9_999;
				return parts;
			},
			"follows its record's create",
		],
		[
			"a live record without revisions",
			(parts) => parts.filter((_, index) => index !== first(parts, "document.revision")),
			"has no base at its version",
		],
		[
			"revisions of a retired none record",
			(parts) => {
				const record = at(parts, first(parts, "document.create")).record as Mutable;
				record.retiredAt = record.createdAt!;
				return parts;
			},
			"keeps no revisions",
		],
		[
			"a retired rewindable record without its history",
			(parts) => {
				const record = at(parts, first(parts, "document.create")).record as Mutable;
				record.history = "rewindable";
				record.retiredAt = record.createdAt!;
				const id = record.id;
				return parts.filter((part) => part.kind !== "document.revision" || part.id !== id);
			},
			"has no base at its version",
		],
		[
			"two live records at one address",
			(parts) => {
				const [one, two] = all(parts, "document.create");
				(at(parts, two!).record as Mutable).key = (at(parts, one!).record as Mutable).key!;
				return parts;
			},
			"a second record at one address for an overlapping lifetime",
		],
		[
			"a record's meta with a NUL",
			(parts) => {
				(at(parts, first(parts, "document.create")).record as Mutable).meta = "a\u0000b";
				return parts;
			},
			"text may not contain NUL",
		],
		[
			"a record's meta with a lone surrogate",
			(parts) => {
				(at(parts, first(parts, "document.create")).record as Mutable).meta = "a\uD800";
				return parts;
			},
			"the meta is not well-formed text",
		],
	])("%s", async (_, edit, message) => {
		const parts = await edited(edit);
		expect(await rejection(imported(parts))).toMatchObject({
			code: "invalid",
			reason: "args",
			message: expect.stringContaining(message),
		});
	});

	it("a non-empty backend is refused; a refused import closes its backend and leaves it as it was", async () => {
		const directory = await mkdtemp(join(tmpdir(), "chord-import-"));
		try {
			const path = join(directory, "store.db");
			const parts = await archive();
			const broken = [...parts.slice(0, -1), { kind: "end", writes: 0 }];
			expect(
				await rejection(importStore(sqliteBackend(await openNodeSqliteDatabase(path)), broken, context)),
			).toMatchObject({
				code: "invalid",
			});
			const db = await openNodeSqliteDatabase(path);
			expect(await db.all("SELECT name FROM sqlite_master")).toEqual([]);
			await db.close();
			const store = await importStore(sqliteBackend(await openNodeSqliteDatabase(path)), parts, context);
			await store.close(context);
			expect(
				await rejection(importStore(sqliteBackend(await openNodeSqliteDatabase(path)), parts, context)),
			).toMatchObject({
				message: "import: the backend holds a store already",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("an input that stalls is cancelled by ctx: the import rejects aborted and the input is closed", async () => {
		const parts = await archive();
		let closed = false;
		const stalled: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]: () => {
				let index = 0;
				return {
					next: () =>
						index < 3
							? Promise.resolve({ done: false, value: parts[index++] })
							: new Promise<IteratorResult<unknown>>(() => {}),
					return: async () => {
						closed = true;
						return { done: true, value: undefined };
					},
				};
			},
		};
		const { context: cancellable, cancel } = withCancel(context);
		const backend = sqliteBackend(await openNodeSqliteDatabase(":memory:"));
		const importing = importStore(backend, stalled, cancellable);
		await new Promise((resolve) => setTimeout(resolve, 10));
		cancel(new Error("stop"));
		expect(await rejection(importing)).toMatchObject({ code: "aborted" });
		expect(closed).toBe(true);
	});
});
