// Surviving drops: a reference held before any link exists, `ref.state` as it follows the link, calls parked while
// loading and sent in order once live, a call in flight when the link drops, and the re-hold after `connect` again.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/10-drops.ts
import { BACKGROUND_CONTEXT, type Context } from "../../../src/context/index.ts";
import { arr, int, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import { type Link, memoryLinkPair } from "../../../src/next/link/index.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "server" };

const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	variants: {
		editor: {
			state: { notes: arr(str()) },
			methods: { add: method(obj({ text: str() }), int()), slow: method() },
		},
	},
});

const NotesDoc = defineState("notes", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

const facet = defineFacet<P>((host) => {
	// Lingers for a minute after its last reference: a client that reconnects within it finds its notes again.
	host.serve(
		Notes,
		(_, _principal, self) => {
			const doc = self.state(NotesDoc);
			return {
				variant: "editor",
				members: {
					notes: self.derive([doc], ([d]) => d.list),
					add: async ({ text }, ctx) => {
						await doc.change((draft) => void draft.list.push(text), ctx);
						return doc.value.list.length;
					},
					slow: (ctx) => new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve(null))),
				},
			};
		},
		{ linger: 60_000 },
	);
});

const server = createHost<P>({ principal: { kind: "server" }, onError: (error) => console.error("server:", error) });
await server.load([{ name: "@example/notes", facet }], context);
const client = createHost<P>({ onError: (error) => console.error("client:", error) });
await client.load([], context);

/** A new link between the hosts: the server stamps the client as its owner. Returns the server's end. */
function connect(server: Host<P>, client: Host<P>, context: Context): Link {
	const [up, down] = memoryLinkPair();
	server.accept(up, { principal: { kind: "owner" } }, context);
	client.connect(down, { principal: { kind: "server" } }, context);
	return up;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// 1. A hold before any link: a reference at once, `loading`, its variant unknown. Calls on it park.
const notes = client.hold(Notes, { session: "S1" }, context);
console.log("held without a link:", notes.state.value, "variant:", notes.variant);
const watch = await notes.state.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") console.log("  ref.state →", call.value.kind);
});
const parked = notes.add({ text: "written while loading" }, context);

// 2. Connect: the reference is held over the link, goes live, and the parked call is sent.
let link = connect(server, client, context);
console.log("parked call's result once live:", await parked);
console.log("notes:", notes.notes.value, "variant:", notes.variant);

// 3. The link drops (the server's end closes it). A call in flight fails `unavailable` and is never resent; the
// reference goes loading and keeps its last values.
const inFlight = notes.slow(context).catch((error: Error) => `rejected: ${error.message}`);
await settle();
link.close();
console.log("in-flight call:", await inFlight);
await settle();
console.log("after the drop:", notes.state.value, "last notes:", notes.notes.value);

// 4. Calls made while the link is down park; they wait at most the reference's readyTimeout (60 s here).
const first = notes.add({ text: "first while down" }, context);
const second = notes.add({ text: "second while down" }, context);

// 5. The app connects again (its link adapter would): every reference is held again with fresh ids, its members get
// the new snapshot as one frame `[["r", value]]`, then the parked calls are sent in the order they were made.
const frames = await notes.notes.watch(context);
frames.start(async (call) => {
	if (call.kind === "value") console.log("  notes frame:", JSON.stringify(call.ops));
});
link = connect(server, client, context);
console.log("parked results, in order:", await first, await second);
await settle();
console.log("notes after the re-hold:", notes.notes.value);

// 6. Release: `ref.state` is `ended` (its error says the holder released it) and its watch ends.
notes.release();
console.log("watch ended:", await watch.closed, "state:", notes.state.value);
await client.close(context);
await server.close(context);
