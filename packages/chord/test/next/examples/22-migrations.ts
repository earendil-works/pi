// Table migrations: `evolveTable` appends a version with its edits (rename, add, json before an optional data step;
// drop, index, dropIndex after it). An object whose store holds an older version migrates it when it activates, one
// version at a time, in chunks of 100 rows; a fresh store gets the newest version directly.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/22-migrations.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet, type Reference } from "../../../src/next/host/index.ts";
import {
	defineTable,
	evolveTable,
	openStore,
	query,
	sqliteBackend,
	type TableDefinition,
} from "../../../src/next/store/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// Version 1, the base, written in full.
const EditsV1 = defineTable("edits", { version: 1, columns: { id: str(), file: str(), at: int() }, key: ["id"] });
// Version 2: `file` becomes `path`, a `dir` column is added and filled from each row (the data step).
const EditsV2 = evolveTable(EditsV1, (t) =>
	t
		.rename("file", "path")
		.add("dir", str({ default: "" }))
		.rows((row) => ({ dir: row.path.slice(0, row.path.lastIndexOf("/")) })),
);
// Version 3: `dir` is dropped again, an index is added. Data functions stay as deployed; history only grows.
const EditsV3 = evolveTable(EditsV2, (t) => t.drop("dir").index("by_path", ["path", "at"]));

const History = local("example.history", {
	version: 1,
	params: {},
	members: { record: method(obj({ id: str(), at: int() })), dump: method(obj({}), arr(str())) },
});

/** The facet of one deployment: its newest table version, and how it writes a row. */
function facetOf(definition: TableDefinition, row: (id: string, at: number) => Record<string, unknown>) {
	return defineFacet((host) => {
		host.serve(History, (_, self) => {
			const edits = self.table(definition);
			return {
				record: async ({ id, at }, ctx) => {
					// A deployment's rows match its own version (an example shortcut for two versions in one file).
					await self.tx(async (tx) => tx.put(edits, row(id, at) as never), ctx);
					return null;
				},
				dump: async (_, ctx) => {
					const lines: string[] = [];
					for await (const row of edits.rows(query(definition), ctx)) lines.push(JSON.stringify(row));
					return lines;
				},
			};
		});
	});
}

/** A host on the store at `path` serving `facet`, run until `work` is done. */
async function deployment(
	path: string,
	facet: ReturnType<typeof facetOf>,
	work: (history: Reference<typeof History>) => Promise<void>,
) {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	const host = createHost({ store, onError: (error) => console.error("background error:", error) });
	// Objects with empty params activate at load: the migration runs before `load` resolves.
	await host.load([{ name: "@example/history", facet }], context);
	await work(await host.get(History, {}, context));
	await host.close(context);
	await store.close(context);
}

const directory = await mkdtemp(join(tmpdir(), "chord-example-"));
const path = join(directory, "history.db");
try {
	await deployment(
		path,
		facetOf(EditsV1, (id, at) => ({ id, file: `src/${id}.ts`, at })),
		async (history) => {
			for (let i = 0; i < 3; i++) await history.record({ id: `e${i}`, at: i }, context);
			console.log("version 1:", await history.dump({}, context));
		},
	);
	// The next deployment declares version 3: the store goes through 2 (rename, add, rows) and 3 (drop, index).
	await deployment(
		path,
		facetOf(EditsV3, (id, at) => ({ id, path: `lib/${id}.ts`, at })),
		async (history) => {
			await history.record({ id: "e9", at: 9 }, context);
			console.log("version 3:", await history.dump({}, context));
		},
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
