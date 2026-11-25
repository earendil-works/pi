// Benchmark of a reference's heap (slice 15 §5): what one reference to a store with 23 named queries costs while none
// is read (a sidebar holding a store for its methods), and with one read. Holds 2,000 references to one object and
// divides the heap they add (after two GCs) by their number, on a SQLite `:memory:` store.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/reference-heap.ts
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local, obj, queries, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet, type Reference } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { defineTable, eq, openStore, query, sqliteBackend } from "../../src/store/index.ts";

const REFERENCES = 2_000;
const QUERIES = 23;

const Rows = defineTable("rows", { version: 1, columns: { id: int(), team: str() }, key: ["id"] });
const Item = obj({ id: int(), team: str() });
const names = Array.from({ length: QUERIES }, (_, index) => `q${index}`);
const Store = local("bench.store", {
	version: 1,
	params: {},
	members: { rows: queries(Item, Object.fromEntries(names.map((name) => [name, obj({ team: str() })]))) },
});

const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const host = createHost({ store, onError: () => {} });
const facet = defineFacet((h) =>
	h.serve(Store, (_, self) => {
		const builders = Object.fromEntries(
			names.map((name) => [name, ({ team }: { team: string }) => query(Rows).where((row) => eq(row.team, team))]),
		);
		return { rows: self.queries(self.table(Rows), { map: (row) => ({ id: row.id, team: row.team }) }, builders) };
	}),
);
await host.load([{ name: "@bench/store", facet }], context);
await host.get(Store, {}, context);

/** The heap after two collections. */
function heap(): number {
	globalThis.gc!();
	globalThis.gc!();
	return process.memoryUsage().heapUsed;
}

/** The heap per reference of `REFERENCES` references to the store, `read` called on each. */
async function perReference(read: (reference: Reference<typeof Store>) => void): Promise<number> {
	const before = heap();
	const held: Reference<typeof Store>[] = [];
	for (let index = 0; index < REFERENCES; index++) {
		const reference = host.hold(Store, {}, context);
		read(reference);
		held.push(reference);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	const per = (heap() - before) / REFERENCES;
	for (const reference of held) reference.release();
	return per;
}

console.log(`1. a reference, no named query read: ${((await perReference(() => {})) / 1024).toFixed(2)} KiB`);
console.log(
	`2. a reference, one named query read: ${((await perReference((reference) => void reference.rows.q0)) / 1024).toFixed(2)} KiB`,
);
await host.close(context);
