// Erasure through the store (outbox format 2): an adapter (Durable's `StoreStorage` deleting a conversation) erases
// what it keeps for good in one commit: a rewindable document with all its history (`purgeDocuments`, recorded as
// `document.purge`) and its table rows (`OwnerTable.deleteWhere`). The deletion travels as writes, so a replica that
// applies the outbox erases it too; the commits stored before it keep their content in the outbox until `trim` passes
// the deletion. Only then is the data gone from the store's tables.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/79-erasure.ts
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, str } from "../../src/contracts/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { StoreOwnerTables } from "../../src/store/adapter.ts";
import { applyBatch } from "../../src/store/apply-batch.ts";
import { type DocumentRecord, insertDocument, purgeDocuments, writeContent } from "../../src/store/engine.ts";
import { defineTable, sqliteBackend } from "../../src/store/index.ts";
import type { StagedWrite, Step } from "../../src/store/step.ts";
import { type ChordStore, openStore } from "../../src/store/store.ts";
import type { StoreWrite } from "../../src/store/writes.ts";

const OPEN = { admit: () => true, adopt: () => {} };

/** A store on `:memory:` with an outbox from its first commit. */
async function opened(): Promise<ChordStore> {
	return (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, {
		outbox: true,
	})) as ChordStore;
}

/** One commit of an adapter's composite write. */
async function commit(store: ChordStore, apply: (step: Step) => Promise<readonly StoreWrite[]>): Promise<void> {
	const write: StagedWrite = { order: "write", apply };
	await store.commit([write], OPEN, context);
}

/** Every stored text of `store` holding `needle`, by table (`all`: the outbox too). */
async function holding(store: ChordStore, needle: string): Promise<string[]> {
	return store.read(async (executor) => {
		const tables = await executor.all<{ readonly name: string }>(
			"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
		);
		const found: string[] = [];
		for (const { name } of tables) {
			const rows = await executor.all<object>(`SELECT * FROM "${name}"`);
			if (rows.some((row) => JSON.stringify(row).includes(needle))) found.push(name);
		}
		return found;
	}, context);
}

// 1. An adapter's data: a table of notes by conversation, and a rewindable document in the conversation's namespace.
const Notes = defineTable("notes", {
	version: 1,
	columns: { id: int(), conversation_id: int(), text: str() },
	key: ["id"],
	indexes: { by_conversation: ["conversation_id"] },
});
const store = await opened();
const tables = new StoreOwnerTables(store, "example.adapter", { label: "example" });
const notes = tables.declare(Notes);
store.claims.documents("example.adapter", "conversation:7", { label: "example" });
await tables.prepare(context);
const row = notes.encode({ id: 1, conversation_id: 7, text: "my secret" });
let id = 0;
await commit(store, async (step) => {
	id = step.ids.mint();
	const record: DocumentRecord = {
		id,
		owner: "example.adapter",
		namespace: "conversation:7",
		kind: "draft",
		history: "rewindable",
		createdAt: step.seq,
		revision: 1,
		version: 1,
		fingerprint: "",
	};
	await insertDocument(step, record, '{"text":"my secret"}');
	const base = { version: 1, fingerprint: "", value: { text: "my secret" } };
	return [await notes.put(step, row), { kind: "document.create", record, base }];
});
// A later revision: a rewindable record keeps both, and retiring it would keep both too.
await commit(store, async (step) => {
	const content = { kind: "base", version: 1, fingerprint: "", value: { text: "my second secret" } } as const;
	await writeContent(step, id, "rewindable", 1, content, JSON.stringify(content.value));
	return [{ kind: "document.change", id, revision: 1, content }];
});
console.log("before:", await holding(store, "secret"));

// 2. The deletion: every record of the namespace with all its revisions, and the conversation's rows, in one commit.
await commit(store, async (step) => [
	...(await purgeDocuments(step, "example.adapter", "conversation:7")),
	await notes.deleteWhere(step, { eq: ["conversation_id", 7] }),
]);
const commits = await store.outbox!.read(store.outbox!.floor, 100, context);
console.log("the deletion's writes:", commits.at(-1)!.writes);
// The data is gone from the tables; the earlier commits in the outbox still hold it.
console.log("after the delete:", await holding(store, "secret"));

// 3. A replica applying the outbox erases it too.
const replica = await opened();
await applyBatch(replica, commits, context);
console.log(
	"replica, outbox aside:",
	(await holding(replica, "secret")).filter((name) => name !== "chord_outbox"),
);

// 4. Erasure is complete once the outbox is trimmed past the deletion (sync trims after the remote acknowledged it).
await store.outbox!.trim(store.lastSeq, context);
console.log("after the trim:", await holding(store, "secret"));
await replica.close(context);
await store.close(context);
