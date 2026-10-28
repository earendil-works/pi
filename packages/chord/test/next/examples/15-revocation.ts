// Revocation: the app says which revocations apply to a principal (`revokedBy`, the same function on every host);
// `host.revoke(r)` ends that principal's objects at once, whatever references remain, closes its child links (tabs) and
// sends `revoke` down every route link, where each worker applies it with its own `revokedBy`. Nothing is replayed.
// What ends gets the error `forbidden` with reason `revoked` (a UI can say "access revoked"): holders get it in `gone`,
// running handlers in their aborted context.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/15-revocation.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, hostKind, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import type { ChordError } from "../../../src/next/data/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";

const context = BACKGROUND_CONTEXT;

/** The app's principals: a guest holds a grant to one session; the server and its workers act as themselves. */
type P =
	| { kind: "owner" }
	| { kind: "guest"; grant: string; session: string }
	| { kind: "server" }
	| { kind: "worker"; session: string };

/** What the app revokes: a grant, or everything of a session. */
type Revocation = { grant: string } | { session: string };

/** The same function on every host: a guest is revoked by its grant and by its session. */
const revokedBy = (p: P): Revocation[] => (p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }] : []);

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	placement: ({ session }) => Session({ id: session }),
	variants: {
		all: { state: { notes: arr(str()) }, methods: { add: method(obj({ text: str() })), follow: method() } },
	},
});

const NotesDoc = defineState("notes", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

const notesFacet = defineFacet<P>((host) => {
	host.serve(Notes, (_, principal, self) => {
		const doc = self.state(NotesDoc);
		console.log(`  worker: Notes for ${principal.kind}${principal.kind === "guest" ? ` ${principal.grant}` : ""}`);
		return {
			variant: "all",
			members: {
				notes: self.derive([doc], ([d]) => d.list),
				add: async ({ text }, ctx) => {
					await doc.change((draft) => void draft.list.push(text), ctx);
					return null;
				},
				// A long-running call: it ends when its context is aborted, and says why.
				follow: async (ctx) => {
					await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
					const { code, reason } = ctx.abortSignal!.reason as ChordError;
					console.log(`  worker: ${principal.kind}'s follow aborted: ${code}/${reason}`);
					return null;
				},
			},
		};
	});
});

// 1. A server with `revokedBy`, routing sessions to in-process workers (trusted links) with the same `revokedBy`.
const server = createHost<P, Revocation>({
	address: Server(),
	principal: { kind: "server" },
	revokedBy,
	onError: console.error,
});
const workers: Host<P, Revocation>[] = [];
server.route(
	Session,
	{
		authorize: (p, address) => p.kind === "owner" || (p.kind === "guest" && p.session === address.params.id),
		resolve: async (address) => {
			const [up, down] = memoryLinkPair();
			const worker = createHost<P, Revocation>({
				address,
				principal: { kind: "worker", session: address.params.id },
				revokedBy,
				onError: console.error,
			});
			worker.connect(up, { principal: { kind: "server" }, trusted: true }, context);
			void worker.load([{ name: "@example/notes", facet: notesFacet }], context);
			workers.push(worker);
			return { link: down, principal: { kind: "worker", session: address.params.id }, trusted: true };
		},
	},
	context,
);
await server.load([], context);

/** A tab whose link the server's entry point stamped with `principal`. */
async function tab(principal: P) {
	const host = createHost<P>({ onError: console.error });
	await host.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal }, context);
	host.connect(b, { principal: { kind: "server" } }, context);
	return host;
}

// 2. Two tabs of guest grant g1 (one person, two windows) and the owner's tab, all on session S1.
const [one, two, owner] = await Promise.all([
	tab({ kind: "guest", grant: "g1", session: "S1" }),
	tab({ kind: "guest", grant: "g1", session: "S1" }),
	tab({ kind: "owner" }),
]);
const guestNotes = await one.get(Notes, { session: "S1" }, context);
await two.get(Notes, { session: "S1" }, context);
const ownerNotes = await owner.get(Notes, { session: "S1" }, context);
await guestNotes.add({ text: "from the guest" }, context);
const following = guestNotes.follow(context).catch((error: ChordError) => error.code);
// The call reaches the worker and runs there.
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("worker S1 references:", workers[0]!.references(Notes).value.length);

// 3. Revoke the grant: the worker gets `revoke { grant: "g1" }` and ends the guest's objects there (their running
// calls aborted with forbidden/revoked), and both guest tabs' links close.
server.revoke({ grant: "g1" }, context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("guest tab:", guestNotes.state.value.kind, "(its link closed; a new one needs a new authentication)");
console.log("guest's follow call:", await following);
// The owner's Notes is its own object (identities include the principal), untouched.
console.log("owner tab:", ownerNotes.state.value.kind, ownerNotes.notes.value);
console.log(
	"worker S1 references:",
	workers[0]!.references(Notes).value.map(({ principal }) => principal?.kind),
);

// 4. A worker resolved later gets no past revocation: its objects are new, and the revoked links are closed already.
const s2 = await owner.get(Notes, { session: "S2" }, context);
console.log("owner on S2:", s2.state.value.kind);

await Promise.all([one, two, owner].map((host) => host.close(context)));
await server.close(context);
await Promise.all(workers.map((worker) => worker.close(context)));
