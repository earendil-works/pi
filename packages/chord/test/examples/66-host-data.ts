// Data belonging to a host (decision "Documents and table rows can belong to a host"): a server object keeps facts
// about each project (a worker host, `Project({ id })`) that it needs while the project's worker is off, in a document
// keyed by the project's address (`keyed: Project`) and in table rows with a `host(Project)` column. The store finds
// them by address, so they travel with the project: `exportHostData` writes them as a store archive next to the
// worker's own store, `importHostData` brings them back (here as a copy under another address) and `deleteHostData`
// removes them. The app kit's `exportData`, `importData` and `deleteData` do these steps for every worker address.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/66-host-data.ts
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, hostKind, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import {
	type ArchivePart,
	defineTable,
	eq,
	host,
	importStore,
	openStore,
	query,
	type Store,
	sqliteBackend,
} from "../../src/store/index.ts";

/** A project: its own worker host and store (here only its store, to keep the example short). */
const Project = hostKind("project", { id: str() });

// 1. On the server: one document per project, keyed by its address, and its labels as rows of a host(Project) column.
const Meta = defineState("example.meta", {
	schema: obj({ title: str() }),
	version: 1,
	initial: () => ({ title: "" }),
	keyed: Project,
	persist: true,
	checkpointWhen: () => false,
});
const Labels = defineTable("example.labels", {
	version: 1,
	columns: { project: host(Project), label: str() },
	key: ["project", "label"],
});

const Projects = local("example.projects", {
	version: 1,
	params: {},
	members: {
		describe: method(obj({ id: str(), title: str(), labels: arr(str()) })),
		show: method(str(), str()),
	},
});

const serverFacet = defineFacet((h) =>
	h.serve(Projects, (_, self) => {
		const meta = self.state(Meta);
		const labels = self.table(Labels);
		return {
			describe: async ({ id, title, labels: names }, ctx) => {
				await self.tx(async (tx) => {
					// Keys are addresses: `Project({ id })`, never a string.
					(await tx.draft(meta, Project({ id }))).title = title;
					for (const label of names) tx.put(labels, { project: Project({ id }), label });
				}, ctx);
				return null;
			},
			show: async (id, ctx) => {
				const title = (await meta.get(Project({ id }), ctx))?.title ?? "(none)";
				const rows = await labels.page(
					query(Labels).where((t) => eq(t.project, Project({ id }))),
					10,
					ctx,
				);
				return `${title} [${rows.items.map((row) => row.label).join(", ")}]`;
			},
		};
	}),
);

/** A new store on `:memory:`. */
async function memory(): Promise<Store> {
	return openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
}

/** Every part of `parts`. */
async function collect(parts: AsyncIterable<ArchivePart>): Promise<ArchivePart[]> {
	const all: ArchivePart[] = [];
	for await (const part of parts) all.push(part);
	return all;
}

const serverStore = await memory();
const server: Host = createHost({ store: serverStore, onError: (error) => console.error("server:", error) });
await server.load([{ name: "@example/projects", facet: serverFacet }], context);
const projects = await server.get(Projects, {}, context);
await projects.describe({ id: "p1", title: "Launch", labels: ["urgent", "web"] }, context);
await projects.describe({ id: "p9", title: "Other", labels: ["later"] }, context);
console.log("1. server:", await projects.show("p1", context), "/", await projects.show("p9", context));

// 2. Export p1: its worker's store (empty here) and the server's records and rows belonging to Project({ id: "p1" }).
const workerArchive = await collect((await memory()).export(context));
const serverPart = await collect(server.exportHostData(Project({ id: "p1" }), context));
const summary = serverPart.map((part) =>
	part.kind === "put"
		? `put ${JSON.stringify(part.row)}`
		: part.kind === "manifest"
			? `manifest ${part.host}`
			: part.kind,
);
console.log("2. p1's server part:", summary);

// 3. Import it as p2: the worker's store into a new store, the server's part as a copy (host cells and keys rewritten).
const p2Store = await importStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), workerArchive, context);
console.log("3. imported:", await server.importHostData(serverPart, context, { address: Project({ id: "p2" }) }));
console.log("   p2:", await projects.show("p2", context));

// 4. Importing again is refused: p2 has data now. With `existing: "replace"` it would replace it.
await server
	.importHostData(serverPart, context, { address: Project({ id: "p2" }) })
	.catch((error: Error) => console.log("4. refused:", error.message));

// 5. Delete p1: its document and rows go; p2 and p9 stay.
console.log("5. deleted:", await server.deleteHostData(Project({ id: "p1" }), context));
console.log("   p1:", await projects.show("p1", context), "/ p2:", await projects.show("p2", context));

projects.release();
await server.close(context);
await serverStore.close(context);
await p2Store.close(context);
