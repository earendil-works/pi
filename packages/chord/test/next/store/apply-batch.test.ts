// Tests of batch apply (slice 6b §1.6, S5, S17): a store's outbox replayed into an empty store gives the same archive,
// manifest included; every write kind (an adapter's create-plus-retire and change-plus-retire too); the refusals (claims held, seqs that do not follow, writes the records refuse)
// and the divergence of a recorded count.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, str } from "../../../src/next/contracts/index.ts";
import { applyBatch } from "../../../src/next/store/apply-batch.ts";
import {
	changeDocument,
	createDocument,
	type DocumentRecord,
	type DocumentWrite,
	insertDocument,
	readDocument,
	retireDocument,
	retireRecord,
	writeContent,
} from "../../../src/next/store/engine.ts";
import { add, type ColumnRef, lt, prefix } from "../../../src/next/store/expression.ts";
import type { OutboxCommit } from "../../../src/next/store/outbox.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";
import { prepareTables } from "../../../src/next/store/table-migration.ts";
import { archiveStore, exported, memoryStore, rejection, tableIn } from "../support.ts";

const OPEN = { admit: () => true, adopt: () => {} };

/** The column references a table's callbacks get (the changes are untyped below the transaction). */
type Refs = { readonly [column: string]: ColumnRef<never, never> | undefined };

const CountsV1 = defineTable("counts", {
	version: 1,
	columns: { id: str(), n: int(), tag: str() },
	key: ["id"],
	indexes: { by_tag: ["tag"] },
});

const CountsV2 = evolveTable(CountsV1, (t) => t.add("extra", int({ default: 0 })).dropIndex("by_tag"));

/** A store with an outbox from its first commit holding every write kind: an archive store, then counted writes. */
async function everyKind(): Promise<ChordStore> {
	const store = await archiveStore({ outbox: true });
	const counts = await tableIn(store, CountsV1);
	const staged: StagedWrite[] = [];
	const changes = new TableChanges(counts, staged);
	for (let i = 0; i < 10; i++) changes.put({ id: `c${i}`, n: i, tag: i % 2 === 0 ? "even" : "odd" });
	await store.commit(staged, OPEN, context);
	const bulk: StagedWrite[] = [];
	const more = new TableChanges(counts, bulk);
	more.update({ id: "c1" }, (c: Refs) => ({ n: add(c.n!, 10) }));
	more.delete({ id: "c2" });
	more.updateWhere((c: Refs) => prefix(c.tag!, "ev"), { tag: "EVEN" });
	more.deleteWhere((c: Refs) => lt(c.n!, 1));
	await store.commit(bulk, OPEN, context);
	await prepareTables([{ definition: CountsV2, table: "app.store:counts" }], store, OPEN, "app.store", context);
	const created: number[] = [];
	const fence = { admit: () => true, adopt: (_: number, ids: readonly number[]) => void created.push(...ids) };
	const address = { owner: "app.store", namespace: "chord", kind: "replayed", key: "x" };
	const base = { version: 1, fingerprint: "f1", value: { n: 0 } };
	await store.commit([createDocument(address, base, '{"n":0}')], fence, context);
	const ops = [["s", ["n"], 1]] as const;
	await store.commit(
		[changeDocument(created[0]!, 1, { kind: "delta", version: 1, ops }, JSON.stringify(ops))],
		OPEN,
		context,
	);
	await store.commit([retireDocument(created[0]!, 2)], OPEN, context);
	await durableShaped(store);
	return store;
}

/**
 * What only an adapter writes (Durable's commits): a rewindable creation retired in its own commit (an empty
 * lifetime), and a change with the retirement of the same record in one commit.
 */
async function durableShaped(store: ChordStore): Promise<void> {
	const address = { owner: "app.durable", namespace: "session", kind: "notes" };
	const base = { version: 1, fingerprint: "", value: { n: 0 } };
	/** A record created at `seq`, retired then too when `retired`. */
	const made = (id: number, key: string, seq: number, retired: boolean): DocumentRecord => ({
		id,
		...address,
		key,
		history: "rewindable",
		createdAt: seq,
		...(retired ? { retiredAt: seq } : {}),
		meta: "{}",
		revision: 1,
		version: 1,
		fingerprint: "",
	});
	const create = (key: string, retired: boolean): StagedWrite => ({
		order: "write",
		apply: async (step) => {
			const record = made(step.ids.mint(), key, step.seq, retired);
			await insertDocument(step, record, '{"n":0}');
			return [{ kind: "document.create", record, base }];
		},
	});
	await store.commit([create("empty", true), create("kept", false)], OPEN, context);
	const kept = (await store.read(
		(executor) => executor.get<{ id: number }>("SELECT id FROM chord_documents WHERE key = 'kept'"),
		context,
	))!.id;
	const ops = [["s", ["n"], 1]] as const;
	const changeAndRetire: StagedWrite = {
		order: "write",
		apply: async (step) => {
			const record = (await readDocument(step, kept))!;
			const content = { kind: "delta", version: 1, ops } as const;
			await writeContent(step, kept, "rewindable", 1, content, JSON.stringify(ops));
			await retireRecord(step, record);
			const writes: DocumentWrite[] = [
				{ kind: "document.change", id: kept, revision: 1, content },
				{ kind: "document.retire", id: kept, revision: 2 },
			];
			return writes;
		},
	};
	await store.commit([changeAndRetire], OPEN, context);
}

/** Every commit of `store`'s outbox. */
async function commits(store: ChordStore): Promise<OutboxCommit[]> {
	return store.outbox!.read(store.outbox!.floor, 10_000, context);
}

describe("replay", () => {
	it("a store's outbox replayed into an empty store gives the same archive, manifest included", async () => {
		const source = await everyKind();
		const all = await commits(source);
		const kinds = new Set(all.flatMap(({ writes }) => writes.map(({ kind }) => kind)));
		expect([...kinds].sort()).toEqual(
			[
				"alter",
				"document.change",
				"document.create",
				"document.retire",
				"dropIndex",
				"index",
				"put",
				"table",
				"update",
				"updateWhere",
				"delete",
				"deleteWhere",
			].sort(),
		);
		const replica = await memoryStore();
		await applyBatch(replica, all.slice(0, 3), context);
		await applyBatch(replica, all.slice(3), context);
		expect(await exported(replica)).toEqual(await exported(source));
		expect([replica.lastSeq, replica.nextId]).toEqual([source.lastSeq, source.nextId]);
	});

	it("restores the allocator: a replica mints above every id it holds", async () => {
		const source = await everyKind();
		const replica = await memoryStore();
		await applyBatch(replica, await commits(source), context);
		expect(replica.mintId()).toBe(source.nextId);
	});

	it("writes the applied commits to the replica's own outbox when it has one", async () => {
		const source = await everyKind();
		const all = await commits(source);
		const replica = await memoryStore({ outbox: true });
		await applyBatch(replica, all, context);
		expect(await commits(replica)).toEqual(all);
	});
});

describe("refusals", () => {
	it("while an owner holds a claim on the store (its memory would go stale)", async () => {
		const replica = await memoryStore();
		replica.claims.documents("app.store", "chord", { label: "an object" });
		expect(await rejection(applyBatch(replica, [], context))).toMatchObject({ code: "invalid", reason: "args" });
	});

	it("a claim taken between the call and its turn in the queue refuses the batch; a claim is refused while it applies", async () => {
		const replica = await memoryStore();
		const held = await replica.take(() => {});
		const replaying = applyBatch(replica, [], context);
		const owner = { label: "an object" };
		replica.claims.documents("app.store", "chord", owner);
		held();
		expect(await rejection(replaying)).toMatchObject({ code: "invalid", reason: "args" });
		expect(replica.lastSeq).toBe(0);
		replica.claims.release(owner);
		const all = await commits(await everyKind());
		let applied = false;
		const applying = applyBatch(replica, all, context).then(() => {
			applied = true;
		});
		// A claim made and released in one turn holds nothing; once the batch applies (across awaits), one is refused.
		let refused: unknown;
		while (!applied && refused === undefined) {
			await Promise.resolve();
			try {
				replica.claims.documents("app.store", "chord", owner);
				replica.claims.release(owner);
			} catch (error) {
				refused = error;
			}
		}
		expect(refused).toMatchObject({ code: "invalid", reason: "args" });
		await applying;
		expect(replica.lastSeq).toBe(all.at(-1)!.seq);
		replica.claims.documents("app.store", "chord", owner);
	});

	it("a batch queued behind one that diverges is refused at its turn", async () => {
		const all = await commits(await everyKind());
		const diverging = structuredClone(all);
		for (const commit of diverging) {
			for (const write of commit.writes) if (write.kind === "updateWhere") (write as { count: number }).count += 1;
		}
		const replica = await memoryStore();
		const first = rejection(applyBatch(replica, diverging, context));
		const second = rejection(applyBatch(replica, all, context));
		expect(String(await first)).toContain("recorded");
		expect(await second).toMatchObject({ code: "invalid", reason: "args" });
		expect(replica.lastSeq).toBe(0);
	});

	it("a commit whose next id is not above a document it creates (a saturated id aside)", async () => {
		const replica = await memoryStore();
		const record = {
			id: 100,
			owner: "app.store",
			namespace: "chord",
			kind: "x",
			history: "rewindable" as const,
			createdAt: 1,
			revision: 1,
			version: 1,
			fingerprint: "",
		};
		const base = { version: 1, fingerprint: "", value: {} };
		const create = { kind: "document.create", record, base } as const;
		expect(await rejection(applyBatch(replica, [{ seq: 1, nextId: 2, writes: [create] }], context))).toMatchObject({
			code: "invalid",
			reason: "args",
		});
		expect(await rejection(applyBatch(replica, [{ seq: 1, nextId: 100, writes: [create] }], context))).toMatchObject({
			reason: "args",
		});
		await applyBatch(replica, [{ seq: 1, nextId: 101, writes: [create] }], context);
		const saturated = { ...create, record: { ...record, id: Number.MAX_SAFE_INTEGER, key: "max" } };
		await applyBatch(replica, [{ seq: 2, nextId: Number.MAX_SAFE_INTEGER, writes: [saturated] }], context);
		expect(replica.lastSeq).toBe(2);
	});

	it("a first commit that does not follow lastSeq, or one that does not follow the one before; nothing applied", async () => {
		const all = await commits(await everyKind());
		const replica = await memoryStore();
		expect(await rejection(applyBatch(replica, all.slice(1), context))).toMatchObject({ reason: "args" });
		expect(await rejection(applyBatch(replica, [all[0]!, all[2]!], context))).toMatchObject({ reason: "args" });
		expect(replica.lastSeq).toBe(0);
		await applyBatch(replica, all, context);
		expect(replica.lastSeq).toBe(all.at(-1)!.seq);
	});

	it("a write the records refuse rolls the batch back, and the store goes on", async () => {
		const all = await commits(await everyKind());
		const replica = await memoryStore();
		const broken = structuredClone(all);
		(broken[0]!.writes[0] as { table: string }).table = "no:such:table";
		expect(await rejection(applyBatch(replica, broken, context))).toMatchObject({ code: "invalid", reason: "args" });
		const forged = structuredClone(all);
		(forged[0]!.writes as unknown[]).push({ kind: "put", table: "x", row: {}, version: 0 });
		expect(await rejection(applyBatch(replica, forged, context))).toMatchObject({ code: "invalid", reason: "args" });
		await applyBatch(replica, all, context);
	});

	it("a recorded count the store does not reproduce stops applying and marks the store diverged (S17)", async () => {
		const all = await commits(await everyKind());
		const index = all.findIndex(({ writes }) => writes.some(({ kind }) => kind === "updateWhere"));
		const diverging = structuredClone(all);
		const write = diverging[index]!.writes.find(({ kind }) => kind === "updateWhere") as { count: number };
		write.count += 1;
		const replica = await memoryStore();
		expect(String(await rejection(applyBatch(replica, diverging, context)))).toContain("recorded");
		expect(await rejection(applyBatch(replica, all, context))).toMatchObject({ code: "invalid", reason: "args" });
		expect(replica.lastSeq).toBe(0);
	});
});
