// Keyed watches and `at(key)`: a keyed document is watched per key; `handle.at(key)` in the factory makes one key a
// watchable (a state member here) that reads `initial()` while absent. A retirement arrives as `initial()` with
// `retired: true`, so a watcher can tell "deleted" from "changed back".
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/23-keyed-watches.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type KeyedHandle } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";

const context = BACKGROUND_CONTEXT;

type Note = { body: string };

const Notes = defineState("notes", {
	schema: obj({ body: str() }),
	version: 1,
	initial: (): Note => ({ body: "" }),
	keyed: true,
});

const Notebook = local("example.notebook", {
	version: 1,
	params: {},
	members: {
		// The note "pinned" as a state member: `initial()` while absent.
		pinned: obj({ body: str() }),
		write: method(obj({ id: str(), body: str() })),
		remove: method(str()),
	},
});

// The example's own window into the object: its keyed handle, to watch other keys from outside.
let notes: KeyedHandle<Note> | undefined;

const facet = defineFacet((host) => {
	host.serve(Notebook, (_, self) => {
		notes = self.state(Notes);
		const handle = notes;
		return {
			// Pinned while this attempt lives, and loaded before the object goes live.
			pinned: handle.at("pinned"),
			write: async ({ id, body }, ctx) => {
				await handle.change(
					id,
					(draft) => {
						draft.body = body;
					},
					ctx,
				);
				return null;
			},
			remove: async (id, ctx) => {
				await handle.retire(id, ctx);
				return null;
			},
		};
	});
});

const host = createHost({ onError: (error) => console.error("background error:", error) });
await host.load([{ name: "@example/notebook", facet }], context);
const notebook = await host.get(Notebook, {}, context);

// A watch of the state member: every value call carries the value, its ops and the retired flag.
const pinned = await notebook.pinned.watch(context);
pinned.start(async (call) => {
	if (call.kind === "value") console.log("pinned:", call.value, call.retired ? "(retired)" : "");
});

await notebook.write({ id: "pinned", body: "buy milk" }, context);
// A watch of one key; an absent key gives `undefined` (watch it once it exists, or pin it with `at`).
console.log("watch of an absent key:", await notes!.watch("later", context));
await notebook.write({ id: "later", body: "call Anna" }, context);
const later = (await notes!.watch("later", context))!;
later.start(async (call) => {
	if (call.kind === "value") console.log("later:", call.value, call.retired ? "(retired)" : "");
});
await notebook.remove("later", context);
await notebook.remove("pinned", context);

// Frames are delivered after the commit, asynchronously: let them arrive before closing.
await new Promise((resolve) => setTimeout(resolve, 10));
await host.close(context);
