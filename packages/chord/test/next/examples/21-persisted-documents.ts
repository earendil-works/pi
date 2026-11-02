// Persisted documents: `persist: true` keeps an object's documents in the host's store, so a new host on the same
// store finds them again; `checkpointWhen` decides when a change is stored as a new base instead of a delta.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/21-persisted-documents.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Reference } from "../../../src/next/host/index.ts";
import { openStore, sqliteBackend } from "../../../src/next/store/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// A persisted singleton: loaded once when its object activates; every 20th stored change is a new base.
const Tags = defineState("tags", {
	schema: obj({ tags: arr(str()) }),
	version: 1,
	initial: () => ({ tags: [] }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});
// A persisted keyed document: each key loaded on its first read, then cached until idle for ten minutes.
const Notes = defineState("notes", {
	schema: obj({ body: str() }),
	version: 1,
	initial: () => ({ body: "" }),
	keyed: true,
	persist: true,
	checkpointWhen: () => false,
});

const Notebook = local("example.notebook", {
	version: 1,
	params: {},
	members: {
		tags: obj({ tags: arr(str()) }),
		write: method(obj({ id: str(), body: str(), tag: str() })),
		read: method(str(), str()),
	},
});

const facet = defineFacet((host) => {
	// Persisted documents need a stable identity, as tables do: a local type with empty params.
	host.serve(Notebook, (_, self) => {
		const tags = self.state(Tags);
		const notes = self.state(Notes);
		return {
			tags,
			write: async ({ id, body, tag }, ctx) => {
				// Both documents commit in one store step, or neither does.
				await self.tx(async (tx) => {
					(await tx.draft(notes, id)).body = body;
					const draft = await tx.draft(tags);
					if (!draft.tags.includes(tag)) draft.tags.push(tag);
				}, ctx);
				return null;
			},
			read: async (id, ctx) => (await notes.get(id, ctx))?.body ?? "(none)",
		};
	});
});

/** A host on the store at `path`, run until `work` is done with the notebook. */
async function session(path: string, work: (notebook: Reference<typeof Notebook>) => Promise<void>) {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	const host = createHost({ store, onError: (error) => console.error("background error:", error) });
	await host.load([{ name: "@example/notebook", facet }], context);
	await work(await host.get(Notebook, {}, context));
	await host.close(context);
	await store.close(context);
}

const directory = await mkdtemp(join(tmpdir(), "chord-example-"));
const path = join(directory, "notebook.db");
try {
	await session(path, async (notebook) => {
		await notebook.write({ id: "groceries", body: "oat milk", tag: "home" }, context);
		await notebook.write({ id: "standup", body: "demo the store", tag: "work" }, context);
		console.log("first host, tags:", notebook.tags.value.tags);
	});
	// A new host on the same file: the documents come back from the store.
	await session(path, async (notebook) => {
		console.log("second host, tags:", notebook.tags.value.tags);
		console.log("second host, standup:", await notebook.read("standup", context));
	});
} finally {
	await rm(directory, { recursive: true, force: true });
}
