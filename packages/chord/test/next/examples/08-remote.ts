// Remote objects over one link: a server and a client host, a remote contract with two variants, a factory choosing
// the variant per principal over a shared local store, and the client's replicas following the server's commits.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/08-remote.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { mapShared } from "../../../src/next/state/index.ts";

const context = BACKGROUND_CONTEXT;

// The app's principals: who calls. Links stamp them; a caller never sets its own.
type P = { kind: "owner" } | { kind: "guest"; session: string } | { kind: "server" };

const Note = obj({ text: str(), author: str() });
const PublicNote = obj({ text: str() });

// A remote contract: one object per (type, params, principal key), in the variant its factory chooses.
const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	variants: {
		editor: { state: { notes: arr(Note), count: int() }, methods: { add: method(obj({ text: str() })) } },
		reader: { state: { notes: arr(PublicNote), count: int() } },
	},
});

// The shared store: the notes of a session once, behind per-principal views (design §6). Local types never cross a link.
const NoteStore = local("example.note-store", {
	version: 1,
	params: { session: str() },
	members: { notes: arr(Note), add: method(Note) },
});

const NotesDoc = defineState("notes", { schema: obj({ list: arr(Note) }), version: 1, initial: () => ({ list: [] }) });

// A redaction computed once per store element, so a reader's derive keeps unchanged notes identical.
const redact = mapShared((note: { text: string; author: string }) => ({ text: note.text }));

const facet = defineFacet<P>((host) => {
	host.serve(NoteStore, (_, self) => {
		const doc = self.state(NotesDoc);
		return {
			notes: self.derive([doc], ([d]) => d.list),
			add: async (note, ctx) => {
				await doc.change((draft) => void draft.list.push(note), ctx);
				return null;
			},
		};
	});
	// A remote factory gets the principal its object is for and returns one variant with exactly its members.
	host.serve(Notes, ({ session }, principal, self) => {
		const store = self.get(NoteStore, { session });
		const count = self.derive([store.notes], ([n]) => n.length);
		if (principal.kind === "guest") {
			return { variant: "reader", members: { notes: self.derive([store.notes], ([n]) => redact(n)), count } };
		}
		return {
			variant: "editor",
			members: {
				notes: store.notes,
				count,
				add: async ({ text }, ctx) => store.add({ text, author: principal.kind }, ctx),
			},
		};
	});
});

// 1. The server: it acts as `server` for its own requests.
const server = createHost<P>({ principal: { kind: "server" }, onError: (error) => console.error("server:", error) });
await server.load([{ name: "@example/notes", facet }], context);

// 2. A client (a tab): no principal of its own. The entry point authenticated it as a guest of S1 and stamps that on
// the link; the client connects before it loads (its plugins may reference server types).
const [up, down] = memoryLinkPair();
server.accept(up, { principal: { kind: "guest", session: "S1" } }, context);
const client = createHost<P>({ onError: (error) => console.error("client:", error) });
client.connect(down, { principal: { kind: "server" } }, context);
await client.load([], context);

// 3. The server writes as an editor; the guest reads the redacted view over the link.
const own = await server.get(Notes, { session: "S1" }, context);
if (own.variant === "editor") await own.add({ text: "hello" }, context);
const notes = await client.get(Notes, { session: "S1" }, context);
console.log("guest variant:", notes.variant);
console.log("guest notes:", JSON.stringify(notes.notes.value), "count:", notes.count.value);

// 4. A commit on the server reaches the client as one state message: both members change in the same batch.
const watch = await notes.notes.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") console.log("frame:", JSON.stringify(call.value), "ops:", JSON.stringify(call.ops));
});
if (own.variant === "editor") await own.add({ text: "world" }, context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("count after the commit:", notes.count.value);

// 5. TypeScript narrows on `variant`: a reader has no `add` (a forged call would fail `invalid/member` at the server).
if (notes.variant === "reader") {
	// @ts-expect-error: `add` is not a member of the reader variant
	void notes.add;
}

// 6. Closing the server closes its links first: the client's reference goes loading and keeps its last values until
// a new link holds it again (10-drops.ts). Closing the client releases it and ends its watches.
await server.close(context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("after the server closed:", notes.state.value, "count:", notes.count.value);
await client.close(context);
console.log("after the client closed:", notes.state.value, await watch.closed);
