// Derives: values computed from documents and from other objects' members, recomputed only when needed.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/03-derives.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { mapShared } from "../../../src/next/state/index.ts";

const context = BACKGROUND_CONTEXT;

const NotesDoc = defineState("notes", {
	schema: obj({ list: arr(obj({ text: str() })) }),
	version: 1,
	initial: () => ({ list: [] }),
});

const Notes = local("example.notes", {
	version: 1,
	params: {},
	members: { titles: arr(str()), count: int(), add: method(obj({ text: str() })) },
});
const Badge = local("example.badge", { version: 1, params: { user: str() }, members: { label: str() } });

const facet = defineFacet((host) => {
	host.serve(Notes, (_, self) => {
		const notes = self.state(NotesDoc);
		// mapShared calls its function once per note object: unchanged notes keep the same title, so the derive's
		// diff after an append is one insert, not a comparison of every title.
		const title = mapShared((note: { text: string }) => {
			console.log("  title computed for:", note.text);
			return note.text.slice(0, 12);
		});
		return {
			// A derive declares its sources; its compute is synchronous and pure.
			titles: self.derive([notes], ([n]) => title(n.list)),
			count: self.derive([notes], ([n]) => n.list.length),
			add: async ({ text }, ctx) => {
				await notes.change((draft) => {
					draft.list.push({ text });
				}, ctx);
				return null;
			},
		};
	});
	// A derive over another object's member, through a reference declared with self.get.
	host.serve(Badge, ({ user }, self) => {
		const notes = self.get(Notes, {});
		return { label: self.derive([notes.count], ([count]) => `${user}: ${count} notes`) };
	});
});

const host = createHost({ onError: (error) => console.error("background error:", error) });
await host.load([{ name: "@example/notes", facet }], context);
const notes = await host.get(Notes, {}, context);
const badge = await host.get(Badge, { user: "mario" }, context);

await notes.add({ text: "buy milk and bread" }, context);
await notes.add({ text: "call Anna" }, context);
// Nobody watches `titles`, so the commits only marked it; reading computes it, each title once.
console.log("titles:", notes.titles.value);
await notes.add({ text: "water plants" }, context);
console.log("titles:", notes.titles.value);
console.log("badge:", badge.label.value);

await host.close(context);
