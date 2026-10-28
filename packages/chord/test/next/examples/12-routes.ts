// Routes: host kinds and addresses, a contract's placement, a server routing a session's objects to an in-process
// worker (one `resolve` per address, `authorize` per principal), a guest's `ctx.get` on the server reaching the worker
// as the guest, and a worker that drops and is resolved again.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/12-routes.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import { type Link, memoryLinkPair } from "../../../src/next/link/index.ts";

const context = BACKGROUND_CONTEXT;

type P =
	| { kind: "owner" }
	| { kind: "guest"; session: string }
	| { kind: "server" }
	| { kind: "worker"; session: string };

// Kinds of addressable hosts; `Session({ id: "S1" })` is an address, its key `session|S1`.
const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

// Notes live on their session's worker: the caller computes the address and sends it with its hold.
const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	placement: ({ session }) => Session({ id: session }),
	variants: {
		editor: {
			state: { notes: arr(str()) },
			methods: { add: method(obj({ text: str() }), int()), whoami: method(undefined, str()) },
		},
		reader: { state: { notes: arr(str()) }, methods: { whoami: method(undefined, str()) } },
	},
});

// The lobby lives on the server (no placement): its handler gets notes for whoever calls it.
const Lobby = remote("example.lobby", {
	version: 1,
	params: {},
	variants: { visitor: { methods: { peek: method(obj({ session: str() }), str()) } } },
});

// The worker's own store of its session's notes, shared by every principal's `Notes` object.
const NoteStore = local("example.note-store", {
	version: 1,
	params: {},
	members: { list: arr(str()), add: method(obj({ text: str() }), int()) },
});

const NotesDoc = defineState("notes", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

/** The worker's facet: an owner edits, anyone else reads; `whoami` shows whom a call acts for. */
const workerFacet = defineFacet<P>((host) => {
	host.serve(NoteStore, (_, self) => {
		const doc = self.state(NotesDoc);
		return {
			list: self.derive([doc], ([d]) => d.list),
			add: async ({ text }, ctx) => {
				await doc.change((draft) => void draft.list.push(text), ctx);
				return doc.value.list.length;
			},
		};
	});
	host.serve(Notes, (_, principal, self) => {
		const store = self.get(NoteStore, {});
		const whoami = async (ctx: { readonly principal: P | undefined }) => JSON.stringify(ctx.principal);
		if (principal.kind !== "owner") return { variant: "reader", members: { notes: store.list, whoami } };
		return { variant: "editor", members: { notes: store.list, add: (args, ctx) => store.add(args, ctx), whoami } };
	});
});

const serverFacet = defineFacet<P>((host) => {
	host.serve(Lobby, () => ({
		variant: "visitor",
		members: {
			// `ctx.get` acts as the caller: over the route, the worker sees the guest, not the server.
			peek: async ({ session }, ctx) => {
				const notes = await ctx.get(Notes, { session });
				return `${notes.variant} variant, ${await notes.whoami(ctx)}`;
			},
		},
	}));
});

// 1. The server: an address, and a route for sessions. `resolve` starts an in-process worker over a memory link and
// returns the link at once (the worker connects first, then loads, W6). `authorize` admits owners everywhere and a
// guest only into its own session.
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
let resolves = 0;
let workerLink: Link | undefined;
server.route(
	Session,
	{
		authorize: (principal, address) =>
			principal.kind === "owner" || (principal.kind === "guest" && principal.session === address.params.id),
		resolve: async (address) => {
			console.log(`server: resolving ${address.key} (resolve #${++resolves})`);
			const [up, down] = memoryLinkPair();
			const worker = createHost<P>({
				address,
				principal: { kind: "worker", session: address.params.id },
				onError: console.error,
			});
			worker.connect(down, { principal: { kind: "server" }, trusted: true }, context);
			void worker.load([{ name: "@example/worker", facet: workerFacet }], context);
			workerLink = up;
			return { link: up, principal: { kind: "worker", session: address.params.id }, trusted: true };
		},
	},
	context,
);
await server.load([{ name: "@example/server", facet: serverFacet }], context);

/** A tab on the server, stamped as `principal` by the server's entry point. */
async function tabAs(principal: P): Promise<Host<P>> {
	const [up, down] = memoryLinkPair();
	server.accept(up, { principal }, context);
	const tab = createHost<P>({ onError: console.error });
	tab.connect(down, { principal: { kind: "server" } }, context);
	await tab.load([], context);
	return tab;
}

// 2. The owner's tab gets S1's notes: tab → server (relays) → route → worker. A second get shares the worker.
const owner = await tabAs({ kind: "owner" });
const notes = await owner.get(Notes, { session: "S1" }, context);
if (notes.variant === "editor") await notes.add({ text: "milk" }, context);
const again = await owner.get(Notes, { session: "S1" }, context);
console.log("owner:", notes.variant, again.notes.value, "resolves so far:", resolves);

// 3. A guest of S1 reads S1 and is refused S2 by `authorize` (no worker is started for it).
const guest = await tabAs({ kind: "guest", session: "S1" });
const read = await guest.get(Notes, { session: "S1" }, context);
console.log("guest:", read.variant, read.notes.value, "acts as", await read.whoami(context));
await guest.get(Notes, { session: "S2" }, context).catch((error) => {
	console.log("guest, S2:", isChordError(error) ? error.code : error, "resolves so far:", resolves);
});

// 4. The guest calls the lobby on the server; its handler's `ctx.get` goes over the route as the guest.
const lobby = await guest.get(Lobby, {}, context);
console.log("guest via the lobby:", await lobby.peek({ session: "S1" }, context));

// 5. The worker drops: references go loading, the route resolves the address again after its backoff (1 s), and
// the new worker (a fresh run, empty notes here) binds them again.
const states: string[] = [];
const watch = await notes.state.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") states.push(call.value.kind);
});
await new Promise((resolve) => setTimeout(resolve, 0));
workerLink!.close();
while (states.length < 2 || states.at(-1) !== "live") await new Promise((resolve) => setTimeout(resolve, 50));
console.log("after the drop:", states.join(" → "), "notes:", notes.notes.value, "resolves:", resolves);

await owner.close(context);
await guest.close(context);
await server.close(context);
