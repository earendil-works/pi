// Flow control: a slow tab. At most two of a provider's own `bound`/`state` messages are unacknowledged per origin;
// while the window is full the provider folds the ops of every commit into its pending queues and sends them as one
// message when an `ack` frees a slot. A relay folds and drops nothing: it forwards at once under the tab's origin and
// returns each `ack` to the worker that sent the message, so a slow tab folds at the worker, alone.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/14-flow-control.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { hostKind, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import { binaryCodec, describeMessage, type Link, memoryLinkPair } from "../../../src/next/link/index.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "server" } | { kind: "worker"; session: string };

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

/** The worker's own document of a streamed reply, and its one write. */
const Reply = local("example.reply", {
	version: 1,
	params: {},
	members: { reply: obj({ text: str() }), append: method(str()) },
});

/** What a tab holds: the reply, on its session's worker. */
const View = remote("example.view", {
	version: 1,
	params: { session: str() },
	placement: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { reply: obj({ text: str() }) } } },
});

const ReplyDoc = defineState("reply", { schema: obj({ text: str() }), version: 1, initial: () => ({ text: "" }) });

const workerFacet = defineFacet<P>((host) => {
	host.serve(Reply, (_, self) => {
		const doc = self.state(ReplyDoc);
		return {
			reply: doc,
			append: async (token, ctx) => {
				await doc.change((draft) => {
					draft.text += token;
				}, ctx);
				return null;
			},
		};
	});
	host.serve(View, (_params, _principal, self) => ({
		variant: "owner",
		members: { reply: self.get(Reply, {}).reply },
	}));
});

/** A worker for `id`, loaded. */
async function worker(id: string): Promise<Host<P>> {
	const host = createHost<P>({
		address: Session({ id }),
		principal: { kind: "worker", session: id },
		onError: console.error,
	});
	await host.load([{ name: "@example/worker", facet: workerFacet }], context);
	return host;
}

/** A link end that logs, as `label`, every `bound`, `state` and `ack` its host receives. */
function tap(link: Link, label: string): Link {
	return {
		send: (message) => link.send(message),
		onMessage: (listener) =>
			link.onMessage((message) => {
				const decoded = binaryCodec.decode(message);
				const shown = decoded.kind === "ack" || decoded.kind === "bound" || decoded.kind === "state";
				if (shown) console.log(`  ${label} ←`, describeMessage(decoded).slice(0, 110));
				listener(message);
			}),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}

/** A slow tab's end of its link: while paused, what arrives waits (so the tab acknowledges nothing). */
class Pausable implements Link {
	paused = false;
	readonly #link: Link;
	readonly #waiting: Uint8Array[] = [];
	#listener: (message: Uint8Array) => void = () => {};

	constructor(link: Link) {
		this.#link = link;
		link.onMessage((message) => {
			if (this.paused) this.#waiting.push(message);
			else this.#listener(message);
		});
	}

	resume(): void {
		this.paused = false;
		for (const message of this.#waiting.splice(0)) this.#listener(message);
	}

	send(message: Uint8Array): void {
		this.#link.send(message);
	}

	onMessage(listener: (message: Uint8Array) => void): void {
		this.#listener = listener;
	}

	close(): void {
		this.#link.close();
	}

	onClose(listener: () => void): void {
		this.#link.onClose(listener);
	}
}

/** A tab connected over `link`, loaded. */
async function tab(link: Link): Promise<Host<P>> {
	const host = createHost<P>({ onError: console.error });
	host.connect(link, { principal: { kind: "server" } }, context);
	await host.load([], context);
	return host;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// 1. Folding at the provider: a tab directly on a worker. Paused, it acknowledges nothing; the worker sends two
// `state` messages (the window), then folds 1,000 appends into its pending queue.
console.log("a slow tab on the provider:");
const w1 = await worker("S1");
const [up, down] = memoryLinkPair();
w1.accept(up, { principal: { kind: "owner" } }, context);
const slow = new Pausable(down);
const t1 = await tab(tap(slow, "tab"));
const view1 = await t1.get(View, { session: "S1" }, context);
const reply1 = await w1.get(Reply, {}, context);
slow.paused = true;
for (let i = 0; i < 1_000; i++) await reply1.append(" tok", context);
await settle();
console.log(
	"  paused: the tab shows",
	view1.reply.value.text.length,
	"characters, the worker has",
	reply1.reply.value.text.length,
);

// 2. Resumed: the tab applies and acknowledges the two, and the freed slot carries one `state` with one folded append.
slow.resume();
await settle();
console.log("  resumed: the tab shows", view1.reply.value.text.length, "characters");

// 3. The same slow tab through a server: its holds reach the worker with the tab's ids under the tab link's origin
// (`["@",1,…]`), the worker's window for that origin fills and it folds there; a second, fast tab is another origin and
// receives every commit.
console.log("a slow tab through a relay:");
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
let w2: Host<P> | undefined;
server.route(
	Session,
	{
		authorize: () => true,
		resolve: async (address) => {
			const [a, b] = memoryLinkPair();
			w2 = await worker(address.params.id);
			w2.connect(tap(b, "worker"), { principal: { kind: "server" }, trusted: true }, context);
			return { link: a, principal: { kind: "worker", session: address.params.id }, trusted: true };
		},
	},
	context,
);
await server.load([], context);
const [up2, down2] = memoryLinkPair();
server.accept(up2, { principal: { kind: "owner" } }, context);
const slow2 = new Pausable(down2);
const t2 = await tab(tap(slow2, "tab"));
const view2 = await t2.get(View, { session: "S2" }, context);
const [up3, down3] = memoryLinkPair();
server.accept(up3, { principal: { kind: "owner" } }, context);
const t3 = await tab(down3);
const view3 = await t3.get(View, { session: "S2" }, context);
let fast = 0;
const watch = await view3.reply.watch(context);
watch.start(async () => {
	fast++;
});
const reply2 = await w2!.get(Reply, {}, context);
slow2.paused = true;
for (let i = 0; i < 5; i++) await reply2.append(` t${i}`, context);
await settle();
console.log("  paused: the slow tab shows", view2.reply.value, "the worker has", reply2.reply.value);
console.log("  the fast tab saw", fast, "changes:", view3.reply.value);

// 4. Resumed: the slow tab acknowledges the two; the relay returns each `ack` to the worker with the origin, and the
// worker's freed slot carries one `state` with the three folded appends.
slow2.resume();
await settle();
console.log("  resumed: the slow tab shows", view2.reply.value);

await t1.close(context);
await w1.close(context);
await watch.stop();
await t2.close(context);
await t3.close(context);
await server.close(context);
await w2!.close(context);
