// The engine (slice 6a §10, §11, slice 6b §1.5): documents as bases and deltas, their keys in code point order, the
// history rules at a new base and at retirement (R1), reads at a point, records inserted as they are.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type { Op } from "../../../src/delta/index.ts";
import type { ArchivePart } from "../../../src/next/store/archive.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import {
	changeDocument,
	createDocument,
	type DocumentAddress,
	type DocumentHistory,
	type DocumentRecord,
	findDocument,
	insertDocument,
	listDocumentKeys,
	listDocuments,
	loadDocument,
	readDocument,
	retireDocument,
	retireRecord,
	writeContent,
} from "../../../src/next/store/engine.ts";
import { importStore } from "../../../src/next/store/import.ts";
import { TABLES } from "../../../src/next/store/schema.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import { type ChordStore, openStore } from "../../../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { exported, rejection } from "../support.ts";

const OWNER = { owner: "app.store", namespace: "chord", kind: "notes" };

/** A store on `:memory:` (or `on`) and a commit helper resolving with the created ids. */
async function engine(on?: ChordStore) {
	const store =
		on ?? ((await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore);
	const commit = async (...writes: StagedWrite[]): Promise<readonly number[]> => {
		let created: readonly number[] = [];
		await store.commit(
			writes,
			{
				admit: () => true,
				adopt: (_seq, ids) => {
					created = ids;
				},
			},
			context,
		);
		return created;
	};
	const at = (key: string): DocumentAddress => ({ ...OWNER, key });
	const base = (value: object, version = 1) => ({
		version,
		fingerprint: `f${version}`.padEnd(16, "0"),
		value: value as never,
	});
	const create = (key: string, value: object) => createDocument(at(key), base(value), JSON.stringify(value));
	const delta = (id: number, revision: number, ops: Op[]) =>
		changeDocument(id, revision, { kind: "delta", version: 1, ops }, JSON.stringify(ops));
	const read = <T>(fn: Parameters<ChordStore["read"]>[0]) => store.read(fn, context) as Promise<T>;
	return { store, commit, at, base, create, delta, read };
}

/** `store`'s archive with `edit` applied to its parts, imported into a fresh `:memory:` store. */
async function reimported(store: ChordStore, edit: (parts: ArchivePart[]) => unknown[]): Promise<ChordStore> {
	const parts = edit(await exported(store));
	return (await importStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), parts, context)) as ChordStore;
}

/** A staged write applying `apply` in the step (an adapter's composite). */
function staged(apply: StagedWrite["apply"]): StagedWrite {
	return { order: "write", apply };
}

/** An adapter's record of `history` at `key`, with an explicit id and the step's seq. */
function record(id: number, key: string, history: DocumentHistory, createdAt: number): DocumentRecord {
	return { id, ...OWNER, key, history, createdAt, revision: 1, version: 1, fingerprint: "" };
}

const LIMIT = Number.MAX_SAFE_INTEGER;

describe("documents", () => {
	it("load as their base with the deltas after it applied; a new base prunes the older revisions", async () => {
		const { commit, at, base, create, delta, read } = await engine();
		const [id] = await commit(create("a", { n: 0 }));
		await commit(delta(id!, 1, [["s", ["n"], 1]]));
		await commit(delta(id!, 2, [["s", ["n"], 2]]));
		const found = (await read<DocumentRecord | undefined>((e) => findDocument(e, at("a"))))!;
		expect(found).toMatchObject({ id, revision: 3, version: 1, history: "none", createdAt: 1 });
		expect(await read((e) => loadDocument(e, found))).toMatchObject({ value: { n: 2 }, deltasSinceBase: 2 });
		const next = base({ m: 9 }, 2);
		await commit(changeDocument(id!, 3, { kind: "base", ...next }, JSON.stringify(next.value)));
		const rebased = (await read<DocumentRecord | undefined>((e) => findDocument(e, at("a"))))!;
		expect(rebased).toMatchObject({ revision: 4, version: 2, fingerprint: next.fingerprint });
		expect(await read((e) => loadDocument(e, rebased))).toMatchObject({ value: { m: 9 }, deltasSinceBase: 0 });
		expect(await read((e) => e.all(`SELECT seq FROM ${TABLES.revisions}`))).toEqual([{ seq: 4 }]);
	});

	it("list live keys in code point order, paging after a key", async () => {
		const { commit, create, read } = await engine();
		await commit(create("\u{1F600}", {}), create("\uFF5E", {}), create("b", {}), create("a", {}));
		expect(await read((e) => listDocumentKeys(e, OWNER, undefined, 10))).toEqual(["a", "b", "\uFF5E", "\u{1F600}"]);
		expect(await read((e) => listDocumentKeys(e, OWNER, "b", 1))).toEqual(["\uFF5E"]);
	});

	it("retire a none record with its row and revisions (R1); the address takes a new incarnation", async () => {
		const { commit, at, create, read } = await engine();
		const [id] = await commit(create("a", { n: 0 }));
		const [next] = await commit(retireDocument(id!, 1), create("a", { n: 1 }));
		expect(next).toBe(3);
		expect(await read((e) => e.all(`SELECT id FROM ${TABLES.documents}`))).toEqual([{ id: 3 }]);
		expect(await read((e) => e.all(`SELECT document_id FROM ${TABLES.revisions}`))).toEqual([{ document_id: 3 }]);
		expect(await read((e) => findDocument(e, at("a")))).toMatchObject({ id: 3 });
	});

	it("refuse two live records at one address and a delta on another version: the step is refused", async () => {
		const first = await engine();
		await first.commit(first.create("a", {}));
		expect(String(await rejection(first.commit(first.create("a", {}))))).toContain("UNIQUE");
		const second = await engine();
		const [id] = await second.commit(second.create("a", {}));
		const crossing = changeDocument(id!, 1, { kind: "delta", version: 2, ops: [] }, "[]");
		expect(String(await rejection(second.commit(crossing)))).toContain("not live at revision 1");
		expect(await second.read(async () => 1)).toBe(1);
	});
});

describe("history rules (R1) and reads at a point", () => {
	/** Creates adapter record `id` at "a" (its base `{ n: 0 }`), then changes and retires it in later commits. */
	async function lifetime(history: DocumentHistory) {
		const { store, commit, at, read } = await engine();
		await commit(
			staged(async (step) => {
				const made = record(10, "a", history, step.seq);
				await insertDocument(step, made, '{"n":0}');
				return [];
			}),
		);
		await commit(
			staged(async (step) => {
				const content = { kind: "base", version: 1, fingerprint: "", value: { n: 1 } } as const;
				await writeContent(step, 10, history, 1, content, '{"n":1}');
				return [];
			}),
		);
		await commit(
			staged(async (step) => {
				await writeContent(
					step,
					10,
					history,
					2,
					{ kind: "delta", version: 1, ops: [["s", ["n"], 2]] },
					'[["s",["n"],2]]',
				);
				return [];
			}),
		);
		// An adapter's retirement (Durable's): the record read in the step, retired by its history's rule.
		await commit(
			staged(async (step) => {
				await retireRecord(step, (await readDocument(step, 10))!);
				return [];
			}),
		);
		return { store, read, at };
	}

	it("keep a retired latest record's row without revisions, and every revision of a rewindable one", async () => {
		const latest = await lifetime("latest");
		expect(await latest.read((e) => e.all(`SELECT id, retired_at FROM ${TABLES.documents}`))).toEqual([
			{ id: 10, retired_at: 4 },
		]);
		expect(await latest.read((e) => e.all(`SELECT seq FROM ${TABLES.revisions}`))).toEqual([]);
		const rewindable = await lifetime("rewindable");
		expect(await rewindable.read((e) => e.all(`SELECT seq, kind FROM ${TABLES.revisions} ORDER BY seq`))).toEqual([
			{ seq: 1, kind: "base" },
			{ seq: 2, kind: "base" },
			{ seq: 3, kind: "delta" },
		]);
	});

	it("find a record at a point by its half-open lifetime, and load a rewindable one at any point inside it", async () => {
		const { read, at } = await lifetime("rewindable");
		const found = await Promise.all(
			[0, 1, 3, 4, "current" as const].map((point) =>
				read<DocumentRecord | undefined>((e) => findDocument(e, at("a"), point)),
			),
		);
		expect(found.map((each) => each?.id)).toEqual([undefined, 10, 10, undefined, undefined]);
		const record = found[1]!;
		expect(record.retiredAt).toBe(4);
		for (const [point, n] of [
			[1, 0],
			[2, 1],
			[3, 2],
		] as const) {
			expect(await read((e) => loadDocument(e, record, point))).toMatchObject({ value: { n }, version: 1 });
		}
		expect(await read((e) => listDocuments(e, OWNER, 3, 0, 10))).toMatchObject([{ id: 10 }]);
		expect(await read((e) => listDocuments(e, OWNER, "current", 0, 10))).toEqual([]);
	});

	it("find a retired latest record at a point, whose content is gone", async () => {
		const { read, at } = await lifetime("latest");
		const found = (await read<DocumentRecord | undefined>((e) => findDocument(e, at("a"), 2)))!;
		expect(found).toMatchObject({ id: 10, retiredAt: 4, history: "latest" });
		// A read returns data (the store stops on a read's throw, slice 6b §1.4): the outcome as a value.
		const outcome = read((e) =>
			loadDocument(e, found, 2).then(
				() => "loaded",
				(error: unknown) => String(error),
			),
		);
		expect(await outcome).toContain("no base");
	});

	it("insert a create-plus-retire as an empty lifetime that never holds the live address", async () => {
		const { commit, read, at, create } = await engine();
		const [live] = await commit(create("a", {}));
		await commit(
			staged(async (step) => {
				await insertDocument(step, { ...record(20, "a", "latest", step.seq), retiredAt: step.seq }, "{}");
				return [];
			}),
		);
		expect(await read((e) => findDocument(e, at("a")))).toMatchObject({ id: live });
		expect(await read((e) => e.all(`SELECT document_id FROM ${TABLES.revisions} WHERE document_id = 20`))).toEqual(
			[],
		);
	});
});

describe("counters at the safe-integer limit", () => {
	it("allocate document ids up to the safe range after an import near it; past it the commit is refused", async () => {
		const { store: source } = await engine();
		const near = (next: number) =>
			reimported(source, ([manifest, ...rest]) => [{ ...manifest, nextId: next }, ...rest]);
		const { store, commit, create } = await engine(await near(LIMIT - 1));
		expect(await commit(create("a", { n: 0 }))).toEqual([LIMIT - 1]);
		expect(store.nextId).toBe(LIMIT);
		expect(String(await rejection(commit(create("b", { n: 0 }))))).toContain("ID space is exhausted");
		// Two creations in one commit where only one id is left: nothing of it is written.
		const both = await engine(await near(LIMIT - 1));
		expect(String(await rejection(both.commit(both.create("a", { n: 0 }), both.create("b", { n: 0 }))))).toContain(
			"ID space is exhausted",
		);
		expect([both.store.lastSeq, both.store.nextId]).toEqual([0, LIMIT - 1]);
	});

	it("count revisions up to the safe range after an import near it; a change past it is refused", async () => {
		const { store: source, commit: seed, create } = await engine();
		await seed(create("a", { n: 0 }));
		const store = await reimported(source, (parts) =>
			parts.map((part) =>
				part.kind === "document.create" ? { ...part, record: { ...part.record, revision: LIMIT - 1 } } : part,
			),
		);
		const { commit, delta, read, at } = await engine(store);
		const found = (await read<DocumentRecord | undefined>((e) => findDocument(e, at("a"))))!;
		await commit(delta(found.id, LIMIT - 1, [["s", ["n"], 1]]));
		expect(String(await rejection(commit(delta(found.id, LIMIT, [["s", ["n"], 2]]))))).toContain("safe range");
	});
});
