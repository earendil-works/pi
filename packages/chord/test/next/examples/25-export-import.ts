// Export and import: `store.export(ctx)` yields the store's state as archive parts (lossless: tables with their rows
// and versions, the live documents), holding the commit queue while it runs; `encodeJsonl` turns them into JSONL.
// `importStore` checks an archive part by part and makes a new store from it in one backend transaction.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/25-export-import.ts
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Reference } from "../../../src/next/host/index.ts";
import {
	decodeJsonl,
	defineTable,
	encodeJsonl,
	importStore,
	openStore,
	type Store,
	sqliteBackend,
} from "../../../src/next/store/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

const Visits = defineTable("visits", { version: 1, columns: { page: str(), count: int() }, key: ["page"] });
const Title = defineState("title", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "untitled" }),
	persist: true,
	checkpointWhen: () => false,
});

const Site = local("example.site", {
	version: 1,
	params: {},
	members: {
		title: obj({ text: str() }),
		visit: method(str(), int()),
		rename: method(str()),
	},
});

const facet = defineFacet((host) => {
	host.serve(Site, (_, self) => {
		const visits = self.table(Visits);
		const title = self.state(Title);
		return {
			title,
			visit: async (page, ctx) =>
				self.tx(async (tx) => {
					const count = ((await tx.get(visits, { page }))?.count ?? 0) + 1;
					tx.put(visits, { page, count });
					return count;
				}, ctx),
			rename: async (text, ctx) => {
				await title.change((draft) => {
					draft.text = text;
				}, ctx);
				return null;
			},
		};
	});
});

/** A host on `store` serving the site, run until `work` is done. */
async function serve(store: Store, work: (site: Reference<typeof Site>) => Promise<void>) {
	const host = createHost({ store, onError: (error) => console.error("background error:", error) });
	await host.load([{ name: "@example/site", facet }], context);
	await work(await host.get(Site, {}, context));
	await host.close(context);
}

const directory = await mkdtemp(join(tmpdir(), "chord-example-"));
try {
	const original = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(directory, "a.db"))), context);
	await serve(original, async (site) => {
		await site.rename("Chord", context);
		await site.visit("/", context);
		await site.visit("/", context);
		await site.visit("/docs", context);
	});
	// Export to a local file (then upload it, if needed): the queue is held only while the parts are read.
	const archive = join(directory, "archive.jsonl");
	await pipeline(encodeJsonl(original.export(context)), createWriteStream(archive));
	console.log("archive:", (await stat(archive)).size, "bytes at seq", original.lastSeq);
	await original.close(context);

	// Import into an empty backend: every part is checked; a refused archive leaves the backend empty.
	const parts = decodeJsonl(createReadStream(archive));
	const copy = await importStore(sqliteBackend(await openNodeSqliteDatabase(join(directory, "b.db"))), parts, context);
	console.log("imported at seq", copy.lastSeq);
	await serve(copy, async (site) => {
		console.log("title:", site.title.value.text, "- next visit of /:", await site.visit("/", context));
	});
	await copy.close(context);
} finally {
	await rm(directory, { recursive: true, force: true });
}
