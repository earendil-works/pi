// Presence and keep-alive counts. `host.references(Type)` is a JSON watchable of the references to objects of a type
// on this host, one entry per reference with the object's params, its principal and its incarnation (two tabs are two
// origins); a derive over it is a viewer count, and a link drop is a departure in the same batch. `host.activity` counts
// what keeps a host busy (holds over links, running calls, jobs, lingering objects), published at most once per
// microtask turn: the app's supervisor decides when an idle worker stops.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/16-presence-and-activity.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { int, method, remote, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "user"; name: string } | { kind: "server" };

/** A shared document view: who else is looking (`viewers`), and a slow method. */
const Doc = remote("example.doc", {
	version: 1,
	params: { id: str() },
	variants: { v: { state: { viewers: int() }, methods: { think: method(undefined, int()) } } },
});

// 1. The server serves `Doc`; its factory derives the viewer count from `host.references(Doc)` (on the facet's host).
const server = createHost<P>({ principal: { kind: "server" }, onError: console.error });
const facet = defineFacet<P>((host) => {
	host.serve(
		Doc,
		({ id }, _principal, self) => ({
			variant: "v",
			members: {
				viewers: self.derive([host.references(Doc)], ([refs]) => refs.filter((ref) => ref.params.id === id).length),
				think: async (ctx) => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return ctx.principal?.kind === "user" ? 42 : 0;
				},
			},
		}),
		{ linger: 50 },
	);
});
await server.load([{ name: "@example/doc", facet }], context);

// 2. The supervisor's view: every publication of the counts.
const activity = await server.activity.watch(context);
activity.start(async (call) => {
	if (call.kind === "value") console.log("  activity:", JSON.stringify(call.value));
});

/** A tab of `name` on a new link; returns the tab and the server's end of its link. */
async function tab(name: string) {
	const host = createHost<P>({ onError: console.error });
	await host.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: { kind: "user", name } }, context);
	host.connect(b, { principal: { kind: "server" } }, context);
	return { host, link: a };
}

// 3. Ada opens the document in two tabs, Bob in one: three references, three incarnations, two objects (one per principal);
// the viewer count is over every object of the document.
const [ada1, ada2, bob] = await Promise.all([tab("ada"), tab("ada"), tab("bob")]);
const doc = await ada1.host.get(Doc, { id: "d1" }, context);
await ada2.host.get(Doc, { id: "d1" }, context);
await bob.host.get(Doc, { id: "d1" }, context);
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("viewers seen by ada:", doc.viewers.value);
const present = server
	.references(Doc)
	.value.map(
		({ principal, incarnation }) => `${principal?.kind === "user" ? principal.name : "?"} @ ${incarnation.slice(-4)}`,
	);
console.log("references:", present);

// 4. A call running counts as activity until it settles.
await doc.think(context);

// 5. Bob's link drops: a departure, at once. Bob's own `Doc` object (identities include the principal) lingers.
bob.link.close();
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("viewers after bob's link dropped:", doc.viewers.value);

// 6. Ada closes both tabs: the object lingers (50 ms) with no references, then ends; then everything is zero.
await ada1.host.close(context);
await ada2.host.close(context);
await new Promise((resolve) => setTimeout(resolve, 100));
console.log("references at the end:", server.references(Doc).value.length);
await activity.stop();
await server.close(context);
