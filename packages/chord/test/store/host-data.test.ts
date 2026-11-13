// Tests of a host's data in a store (decision "Documents and table rows can belong to a host"; spec
// `docs/host-keyed/spec.md` §4): the export of one address's records and rows, the checks of a host's data archive,
// its import into an empty store and into one with data (refused, replaced, copied under a new address), the refusals
// of a table at another version and of a row taking another address's key, and the delete, each one commit of
// ordinary writes.

import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, local, method, obj, opt, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import type { Reference } from "../../src/host/index.ts";
import type { ArchivePart } from "../../src/store/archive.ts";
import { listHostRecords } from "../../src/store/engine.ts";
import { host } from "../../src/store/host-column.ts";
import {
	deleteHostData,
	exportHostData,
	type HostArchive,
	type HostCommit,
	importHostData,
	readHostArchive,
} from "../../src/store/host-data.ts";
import * as storeApi from "../../src/store/index.ts";
import { eq, json, query } from "../../src/store/index.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { evolveTable } from "../../src/store/table-evolve.ts";
import { loaded, memoryStore, rejection, Session } from "../support.ts";

const Meta = defineState("meta", {
	schema: obj({ title: str() }),
	version: 1,
	initial: () => ({ title: "" }),
	keyed: Session,
	persist: true,
	checkpointWhen: () => false,
});

/** A string-keyed document whose key looks like an address: it never belongs to a host. */
const Plain = defineState("plain", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "" }),
	keyed: true,
	persist: true,
	checkpointWhen: () => false,
});

const Labels = defineTable("labels", {
	version: 1,
	columns: { session: host(Session), label: str(), note: json(obj({ text: str() }), { version: 1 }) },
	key: ["session", "label"],
});

/** The host column is not the key's first: the table gets the index `host`. */
const Pins = defineTable("pins", { version: 1, columns: { id: str(), session: host(Session) }, key: ["id"] });

const Data = obj({ title: str(), labels: arr(str()), notes: arr(str()), pin: opt(str()) });

const Sessions = local("test.sessions", {
	version: 1,
	params: {},
	members: {
		write: method(obj({ id: str(), title: str(), labels: arr(str()), pin: str() })),
		read: method(str(), Data),
	},
});

/** Serves `Sessions` on `store`. */
async function sessions(store: ChordStore) {
	const { host: h } = await loaded(
		(facet) =>
			facet.serve(Sessions, (_, self) => {
				const meta = self.state(Meta);
				const plain = self.state(Plain);
				const rows = self.table(Labels);
				const pins = self.table(Pins);
				return {
					write: async ({ id, title, labels: names, pin }, ctx) => {
						await self.tx(async (tx) => {
							const session = Session({ id });
							(await tx.draft(meta, session)).title = title;
							(await tx.draft(plain, session.key)).text = title;
							for (const label of names) {
								tx.put(rows, { session, label, note: { text: `${session.key}: ${label}` } });
							}
							tx.put(pins, { id: pin, session });
						}, ctx);
						return null;
					},
					read: async (id, ctx) => {
						const session = Session({ id });
						const page = await rows.page(
							query(Labels).where((t) => eq(t.session, session)),
							50,
							ctx,
						);
						const pin = await pins.page(
							query(Pins).where((t) => eq(t.session, session)),
							1,
							ctx,
						);
						return {
							title: (await meta.get(session, ctx))?.title ?? "",
							labels: page.items.map((row) => row.label),
							notes: page.items.map((row) => row.note.text),
							...(pin.items[0] === undefined ? {} : { pin: pin.items[0].id }),
						};
					},
				};
			}),
		{ store },
	);
	return h;
}

/** Runs `work` on a host serving `Sessions` on `store`, then closes it. */
async function using<T>(store: ChordStore, work: (data: Reference<typeof Sessions>) => Promise<T>): Promise<T> {
	const h = await sessions(store);
	try {
		return await work(await h.get(Sessions, {}, context));
	} finally {
		await h.close(context);
	}
}

/** A store with the data of S1 and S2. */
async function populated(): Promise<ChordStore> {
	const store = await memoryStore({ outbox: true });
	await using(store, async (data) => {
		await data.write({ id: "S1", title: "one", labels: ["a", "b"], pin: "p1" }, context);
		await data.write({ id: "S2", title: "two", labels: ["c"], pin: "p2" }, context);
	});
	return store;
}

/** The parts of `address`'s export from `store`. */
async function exportedHost(store: ChordStore, id: string): Promise<ArchivePart[]> {
	const parts: ArchivePart[] = [];
	for await (const part of exportHostData(store, Session({ id }), context)) parts.push(part);
	return parts;
}

/** The data of session `id` as `Sessions` reads it from `store`. */
function readData(store: ChordStore, id: string): Promise<unknown> {
	return using(store, (data) => data.read(id, context));
}

/** A host data commit nobody coordinates (no live owner in these tests). */
const OPEN: HostCommit = { fence: { admit: () => true, adopt: () => {} }, after: [] };

/** `parts` read as an archive of sessions. */
function readArchive(parts: ArchivePart[]): Promise<HostArchive> {
	return readHostArchive(parts, context);
}

/** Imports `archive` into `store` under `options.address` or its own, refusing or replacing existing data. */
function importInto(
	store: ChordStore,
	archive: HostArchive,
	options: { readonly address?: { readonly key: string }; readonly existing?: "refuse" | "replace" } = {},
) {
	const plan = {
		target: options.address?.key ?? archive.host,
		existing: options.existing ?? "refuse",
		histories: new Map(),
	};
	return importHostData(store, archive, plan, OPEN, context);
}

const stores: ChordStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close(context);
});

/** A store closed after the test. */
async function track(store: Promise<ChordStore>): Promise<ChordStore> {
	const made = await store;
	stores.push(made);
	return made;
}

describe("export", () => {
	it("holds only the address's records and rows: tables with a host column, their indexes, no string-keyed record", async () => {
		const store = await track(populated());
		const parts = await exportedHost(store, "S1");
		expect(parts[0]).toMatchObject({ kind: "manifest", host: "session|S1" });
		const summary = parts.slice(1).map((part) => {
			if (part.kind === "put") return `put ${part.table} ${JSON.stringify(part.row.session)}`;
			if (part.kind === "table" || part.kind === "index") return `${part.kind} ${part.table}`;
			if (part.kind === "document.create") return `create ${part.record.kind} ${part.record.host}`;
			return part.kind;
		});
		expect(summary).toEqual([
			"table test.sessions:labels",
			'put test.sessions:labels "session|S1"',
			'put test.sessions:labels "session|S1"',
			"table test.sessions:pins",
			'put test.sessions:pins "session|S1"',
			"index test.sessions:pins",
			"create meta session|S1",
			"document.revision",
			"end",
		]);
		expect(parts.at(-1)).toEqual({ kind: "end", writes: parts.length - 2 });
		const table = parts.find((part) => part.kind === "table");
		expect(table).toMatchObject({ columns: { session: { type: "str", host: "session" } } });
	});
});

describe("import", () => {
	it("makes the data in an empty store: fresh ids and seqs, the values as bases", async () => {
		const archive = await readArchive(await exportedHost(await track(populated()), "S1"));
		const target = await track(memoryStore());
		expect(await importInto(target, archive)).toEqual({ documents: 1, rows: 3 });
		expect(await readData(target, "S1")).toEqual({
			title: "one",
			labels: ["a", "b"],
			notes: ["session|S1: a", "session|S1: b"],
			pin: "p1",
		});
		const records = await target.read((executor) => listHostRecords(executor, "session|S1", 0, 10), context);
		expect(records).toEqual([expect.objectContaining({ key: "session|S1", host: "session|S1", createdAt: 1 })]);
	});

	it("refuses an address with data, leaving the store as it was; replaces it when asked", async () => {
		const archive = await readArchive(await exportedHost(await track(populated()), "S1"));
		const target = await track(memoryStore());
		await using(target, (data) => data.write({ id: "S1", title: "old", labels: ["z"], pin: "p9" }, context));
		const before = target.lastSeq;
		expect(await rejection(importInto(target, archive))).toMatchObject({
			code: "invalid",
			reason: "args",
			message: expect.stringContaining('session|S1 has data in this store (import with existing: "replace")'),
		});
		expect(target.lastSeq).toBe(before);
		expect(await importInto(target, archive, { existing: "replace" })).toEqual({
			documents: 1,
			rows: 3,
		});
		expect(await readData(target, "S1")).toEqual({
			title: "one",
			labels: ["a", "b"],
			notes: ["session|S1: a", "session|S1: b"],
			pin: "p1",
		});
	});

	it("copies under a new address: host cells and keys rewritten, addresses inside JSON untouched", async () => {
		const source = await track(populated());
		const archive = await readArchive(await exportedHost(source, "S1"));
		const pins = archive.tables.find((table) => table.write.table.endsWith(":pins"))!;
		const renamed: HostArchive = {
			...archive,
			tables: archive.tables.map((table) =>
				table === pins
					? { ...table, puts: [{ ...pins.puts[0]!, row: { ...pins.puts[0]!.row, id: "p3" } }] }
					: table,
			),
		};
		await importInto(source, renamed, { address: Session({ id: "S3" }) });
		expect(await readData(source, "S3")).toEqual({
			title: "one",
			labels: ["a", "b"],
			notes: ["session|S1: a", "session|S1: b"],
			pin: "p3",
		});
		expect(await readData(source, "S1")).toMatchObject({ title: "one", pin: "p1" });
	});

	it("refuses another kind, a table at another version, and a row whose key holds another address's row", async () => {
		const source = await track(populated());
		const archive = await readArchive(await exportedHost(source, "S1"));
		expect(await rejection(importInto(source, archive, { address: { key: "user" } }))).toMatchObject({
			message: expect.stringContaining("another kind"),
		});
		// S3 in the source: the pin `p1` is S1's.
		expect(await rejection(importInto(source, archive, { address: Session({ id: "S3" }) }))).toMatchObject({
			message: expect.stringContaining('a row with key ["p1"] exists'),
		});
		// A store whose `labels` table is at version 2.
		const newer = evolveTable(Labels, (t) => t.add("extra", opt(str())));
		const target = await track(memoryStore());
		const { host: h } = await loaded(
			(facet) =>
				facet.serve(Sessions, (_, self) => {
					self.table(newer);
					return { write: async () => null, read: async () => ({ title: "", labels: [], notes: [] }) };
				}),
			{ store: target },
		);
		await h.close(context);
		expect(await rejection(importInto(target, archive))).toMatchObject({
			message: expect.stringContaining("at version 1, 2 here; its owner is not live"),
		});
	});

	it("is recorded in the outbox as ordinary writes", async () => {
		const source = await track(populated());
		const archive = await readArchive(await exportedHost(source, "S1"));
		await importInto(source, archive, { existing: "replace" });
		const [commit] = await source.outbox!.read(source.lastSeq - 1, 1, context);
		expect(commit!.writes.map((write) => write.kind)).toEqual([
			"document.retire",
			"deleteWhere",
			"deleteWhere",
			"put",
			"put",
			"put",
			"document.create",
		]);
	});
});

describe("archive checks", () => {
	const manifest = { kind: "manifest", format: 1, schema: 3, lastSeq: 5, nextId: 9, host: "session|S1" };

	it.each<[string, unknown[], string]>([
		[
			"no host",
			[
				{ ...manifest, host: undefined },
				{ kind: "end", writes: 0 },
			],
			"not a host's data archive",
		],
		["no end", [manifest], "no end part"],
		[
			"a table without a host column",
			[
				manifest,
				{
					kind: "table",
					table: "a:b",
					version: 1,
					state: "ready",
					columns: { id: { type: "str" } },
					key: ["id"],
					fingerprint: "f",
				},
				{ kind: "end", writes: 1 },
			],
			"no single host column of session",
		],
		[
			"a row of another address",
			[
				manifest,
				{
					kind: "table",
					table: "a:b",
					version: 1,
					state: "ready",
					columns: { s: { type: "str", host: "session" } },
					key: ["s"],
					fingerprint: "f",
				},
				{ kind: "put", table: "a:b", row: { s: "session|S2" }, version: 1, columns: {} },
				{ kind: "end", writes: 2 },
			],
			"does not belong to session|S1",
		],
		[
			"a record of another address",
			[
				manifest,
				{ kind: "document.create", record: record({ host: "session|S2", key: "session|S2" }) },
				{ kind: "end", writes: 1 },
			],
			"does not belong to session|S1",
		],
		[
			"a record that is not Chord's",
			[manifest, { kind: "document.create", record: record({ history: "latest" }) }, { kind: "end", writes: 1 }],
			"not a live Chord record",
		],
		[
			"a record without a base",
			[manifest, { kind: "document.create", record: record({}) }, { kind: "end", writes: 1 }],
			"has no base at its version",
		],
	])("refuses %s", async (_name, parts, message) => {
		expect(await rejection(readHostArchive(parts, context))).toMatchObject({
			code: "invalid",
			message: expect.stringContaining(message),
		});
	});

	it("folds a record's base and deltas into its value", async () => {
		const archive = await readHostArchive(
			[
				manifest,
				{ kind: "document.create", record: record({}) },
				{ kind: "document.revision", id: 3, seq: 2, content: { kind: "base", version: 1, value: { title: "a" } } },
				{
					kind: "document.revision",
					id: 3,
					seq: 4,
					content: { kind: "delta", version: 1, ops: [["s", ["title"], "b"]] },
				},
				{ kind: "end", writes: 3 },
			],
			context,
		);
		expect(archive.documents.map(({ value }) => value)).toEqual([{ title: "b" }]);
	});
});

/** A document record of S1 at id 3, with `fields` changed. */
function record(fields: object): object {
	return {
		id: 3,
		owner: "test.sessions",
		namespace: "chord",
		kind: "meta",
		key: "session|S1",
		host: "session|S1",
		history: "none",
		createdAt: 2,
		revision: 1,
		version: 1,
		fingerprint: "f",
		...fields,
	};
}

describe("delete", () => {
	it("retires the address's records and deletes its rows in one commit, other addresses untouched", async () => {
		const store = await track(populated());
		expect(await deleteHostData(store, "session|S1", OPEN, context)).toEqual({ documents: 1, rows: 3 });
		expect(await readData(store, "S1")).toEqual({ title: "", labels: [], notes: [] });
		expect(await readData(store, "S2")).toMatchObject({ title: "two", labels: ["c"], pin: "p2" });
		const [commit] = await store.outbox!.read(store.lastSeq - 1, 1, context);
		expect(commit!.writes).toEqual([
			{ kind: "document.retire", id: expect.any(Number), revision: 1 },
			{ kind: "deleteWhere", table: "test.sessions:labels", where: { eq: ["session", "session|S1"] }, count: 2 },
			{ kind: "deleteWhere", table: "test.sessions:pins", where: { eq: ["session", "session|S1"] }, count: 1 },
		]);
		// The string-keyed document with the same key is no host's: still there.
		const plain = await store.read(
			(executor) =>
				executor.get<{ readonly n: number }>("SELECT count(*) AS n FROM chord_documents WHERE kind = 'plain'"),
			context,
		);
		expect(plain?.n).toBe(2);
	});
});

describe("review round 2", () => {
	it("checks rows by the recorded host column, whatever the archive's metadata says (a moved host annotation)", async () => {
		const store = await track(populated());
		const parts = (await exportedHost(store, "S1")).map((part) => {
			if (part.kind === "table" && part.table.endsWith(":labels")) {
				return {
					...part,
					columns: { ...part.columns, session: { type: "str" }, label: { type: "str", host: "session" } },
				};
			}
			if (part.kind === "put" && part.table.endsWith(":labels")) {
				return { ...part, row: { ...part.row, session: "session|VICTIM", label: "session|S1" } };
			}
			return part;
		}) as ArchivePart[];
		const archive = await readArchive(parts);
		expect(await rejection(importInto(store, archive, { existing: "replace" }))).toMatchObject({
			message: expect.stringContaining("a row that does not belong to session|S1"),
		});
		expect(await readData(store, "VICTIM")).toEqual({ title: "", labels: [], notes: [] });
	});

	it("refuses a table exported during a migration when no history can resume it", async () => {
		const store = await track(populated());
		const parts = (await exportedHost(store, "S1")).map((part) =>
			part.kind === "table" && part.table.endsWith(":labels") ? { ...part, state: "migrating" as const } : part,
		);
		expect(await rejection(importInto(store, await readArchive(parts), { existing: "replace" }))).toMatchObject({
			message: expect.stringContaining("its owner is not live"),
		});
	});

	it("selects by the canonical key: a lone surrogate in an address is U+FFFD in cells, keys and the export", async () => {
		const store = await track(memoryStore());
		await using(store, (data) => data.write({ id: "x\uD800", title: "odd", labels: ["a"], pin: "p" }, context));
		const parts = await exportedHost(store, "x\uD800");
		expect(parts[0]).toMatchObject({ host: "session|x\uFFFD" });
		expect(parts.filter((part) => part.kind === "put").length).toBe(2);
		expect(parts.filter((part) => part.kind === "document.create").length).toBe(1);
		expect(await deleteHostData(store, "session|x\uFFFD", OPEN, context)).toEqual({ documents: 1, rows: 2 });
	});

	it("keeps import and delete off the store's public surface: the host is the only way", () => {
		expect(Object.keys(storeApi)).toContain("exportHostData");
		expect(Object.keys(storeApi)).not.toContain("importHostData");
		expect(Object.keys(storeApi)).not.toContain("deleteHostData");
	});
});
