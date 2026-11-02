// Documents and transactions: an object's in-memory JSON state, written atomically.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/02-documents.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";

const context = BACKGROUND_CONTEXT;

// A singleton document: one per object, `initial()` until written.
const Todos = defineState("todos", {
	schema: obj({ items: arr(obj({ id: int(), text: str() })), next: int() }),
	version: 1,
	initial: () => ({ items: [], next: 1 }),
});
// A keyed document: many per object, one per string key, absent until written.
const Notes = defineState("notes", {
	schema: obj({ body: str() }),
	version: 1,
	initial: () => ({ body: "" }),
	keyed: true,
});

const Store = local("example.todos", {
	version: 1,
	params: {},
	members: {
		todos: obj({ items: arr(obj({ id: int(), text: str() })), next: int() }),
		add: method(obj({ text: str(), note: opt(str()) }), int()),
		note: method(obj({ id: int() }), str()),
		clear: method(),
	},
});

const facet = defineFacet((host) => {
	host.serve(Store, (_, self) => {
		const todos = self.state(Todos);
		const notes = self.state(Notes);
		return {
			// A singleton handle is a watchable, so it can be a state member as it is.
			todos,
			add: async ({ text, note }, ctx) => {
				// One transaction over two documents: both change together, or neither does.
				const id = await self.tx(async (tx) => {
					const draft = await tx.draft(todos);
					const id = draft.next++;
					draft.items.push({ id, text });
					if (note !== undefined) (await tx.draft(notes, String(id))).body = note;
					// Return plain values: drafts are revoked once the transaction settles.
					return id;
				}, ctx);
				return id;
			},
			// Read keyed documents outside transactions; an absent one is `undefined`.
			note: async ({ id }, ctx) => (await notes.get(String(id), ctx))?.body ?? "(none)",
			clear: async (ctx) => {
				// Shorthands for one document: retire resets a singleton to `initial()`.
				await todos.retire(ctx);
				for await (const key of notes.keys(ctx)) await notes.retire(key, ctx);
				return null;
			},
		};
	});
});

const host = createHost({ onError: (error) => console.error("background error:", error) });
await host.load([{ name: "@example/todos", facet }], context);
const store = await host.get(Store, {}, context);

const first = await store.add({ text: "buy milk", note: "the oat one" }, context);
await store.add({ text: "call Anna" }, context);
console.log("todos:", store.todos.value.items);
console.log("note of", first, "->", await store.note({ id: first }, context));

await store.clear(context);
console.log("after clear:", store.todos.value, await store.note({ id: first }, context));

await host.close(context);
