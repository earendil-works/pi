// Size limits per part and compression at the origin. A host with a synchronous compressor (`nodeCompression` on
// Node) deflates each JSON part above 16 KiB once, when it encodes it; relays forward it as it is; the end that owns it
// inflates it, within its link's decoded limit. A browser has no synchronous deflate: it sends uncompressed and
// inflates with `DecompressionStream`, later messages of its link waiting in order. Only a part that shrinks is sent
// deflated, and never hold params. Clients never send compressed parts: a host sends its call arguments up its parent
// link uncompressed, and a link the server accepted (a child) refuses compressed parts as a protocol error (a small
// part could inflate to 64 MiB there). A part past a limit fails only its own hold or call (`too_large/part`); the
// link stays. Limits and the threshold count UTF-8 bytes.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/17-limits-and-compression.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import { type Compression, type Link, memoryLinkPair, type PartLimits } from "../../../src/next/link/index.ts";
import { nodeCompression } from "../../../src/next-node/compression.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "user" } | { kind: "server" };

const Entry = obj({ id: str(), text: str() });

/** The shared store of a conversation: its entries, once, and the method that appends to them. */
const Store = local("example.store", {
	version: 1,
	params: { id: str() },
	members: { entries: arr(Entry), append: method(Entry) },
});

/** What a tab holds: the conversation's entries, and appending. */
const Conversation = remote("example.conversation", {
	version: 1,
	params: { id: str() },
	variants: { v: { state: { entries: arr(Entry) }, methods: { append: method(Entry) } } },
});

const Entries = defineState("entries", {
	schema: obj({ list: arr(Entry) }),
	version: 1,
	initial: () => ({ list: [] }),
});

const facet = defineFacet<P>((host) => {
	host.serve(Store, (_, self) => {
		const doc = self.state(Entries);
		return {
			entries: self.derive([doc], ([d]) => d.list),
			append: async (entry, ctx) => {
				await doc.change((draft) => void draft.list.push(entry), ctx);
				return null;
			},
		};
	});
	host.serve(Conversation, ({ id }, _principal, self) => {
		const store = self.get(Store, { id });
		return { variant: "v", members: { entries: store.entries, append: (entry, ctx) => store.append(entry, ctx) } };
	});
});

/** A link end counting the bytes its host receives. */
function counted(link: Link, bytes: { received: number }): Link {
	return {
		send: (message) => link.send(message),
		onMessage: (listener) =>
			link.onMessage((message) => {
				bytes.received += message.byteLength;
				listener(message);
			}),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}

/**
 * A server compressing with `compression` and a tab without a compressor (a browser) on a link the server accepts with
 * `limits`; the tab's own link to the server has `tabLimits`.
 */
async function setUp(compression: Compression | undefined, limits?: PartLimits, tabLimits?: PartLimits) {
	const server = createHost<P>({ principal: { kind: "server" }, compression, onError: console.error });
	await server.load([{ name: "@example/conversation", facet }], context);
	const tab = createHost<P>({ onError: console.error });
	await tab.load([], context);
	const [a, b] = memoryLinkPair();
	const bytes = { received: 0 };
	server.accept(a, { principal: { kind: "user" }, limits }, context);
	tab.connect(counted(b, bytes), { principal: { kind: "server" }, limits: tabLimits }, context);
	return { server, tab, bytes };
}

/** Words for entries that compress like prose (about 3x), not like a repeated string. */
const WORDS = "the a model tool call file read write test error result agent session note code run build".split(" ");

/** Entry `i`'s text: about 1 KB of words picked by a fixed pseudo-random sequence. */
function text(i: number): string {
	let seed = i * 7919 + 1;
	const words: string[] = [];
	for (let length = 0; length < 1000; length += words.at(-1)!.length + 1) {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		const word = WORDS[seed % WORDS.length]!;
		words.push(seed % 5 === 0 ? `${word}${seed % 1000}` : word);
	}
	return words.join(" ");
}

/** Fills the server's conversation `id` with 500 entries of about 1 KB (its store kept by this reference). */
async function fill(server: Host<P>, id: string): Promise<void> {
	const conversation = await server.get(Store, { id }, context);
	for (let i = 0; i < 500; i++) await conversation.append({ id: `e${i}`, text: text(i) }, context);
}

// 1. A 500 KB snapshot to a browser tab, without and with compression at the server.
for (const compression of [undefined, nodeCompression]) {
	const { server, tab, bytes } = await setUp(compression);
	await fill(server, "c1");
	const started = performance.now();
	const conversation = await tab.get(Conversation, { id: "c1" }, context);
	const ms = (performance.now() - started).toFixed(1);
	const label = compression === undefined ? "uncompressed" : "deflated at the server, inflated asynchronously";
	console.log(
		`snapshot ${label}: ${conversation.entries.value.length} entries, ${(bytes.received / 1024).toFixed(1)} KiB received, ${ms} ms`,
	);
	await tab.close(context);
	await server.close(context);
}

// 2. Limits per part: the server admits at most 64 KiB per part from this tab. A larger argument fails its call only.
{
	const { server, tab } = await setUp(nodeCompression, { part: 64 * 1024 });
	const conversation = await tab.get(Conversation, { id: "c2" }, context);
	try {
		await conversation.append({ id: "big", text: "x".repeat(100_000) }, context);
	} catch (error) {
		console.log(
			"a 100 KB argument:",
			isChordError(error) ? `${error.code}/${error.reason}: ${error.message}` : error,
		);
	}
	await conversation.append({ id: "small", text: "fits" }, context);
	console.log(
		"the link stays: entries",
		conversation.entries.value.map(({ id }) => id),
	);
	await tab.close(context);
	await server.close(context);
}

// 3. A compression bomb: 50 KB deflated that would inflate to 6 MB, past the tab's decoded limit of 1 MiB. The tab
// stops inflating at the limit; only that hold fails.
{
	const { server, tab } = await setUp(nodeCompression, undefined, { decoded: 1024 * 1024 });
	const bomb = await server.get(Store, { id: "bomb" }, context);
	for (let i = 0; i < 6; i++) await bomb.append({ id: `z${i}`, text: "0".repeat(1_000_000) }, context);
	await fill(server, "fine");
	try {
		await tab.get(Conversation, { id: "bomb" }, context);
	} catch (error) {
		console.log("the bomb's hold:", isChordError(error) ? `${error.code}/${error.reason}` : error);
	}
	const fine = await tab.get(Conversation, { id: "fine" }, context);
	console.log("another hold on the same link:", fine.entries.value.length, "entries");
	await tab.close(context);
	await server.close(context);
}

// 4. A client with a compressor still sends its arguments up uncompressed: the server, which accepted its link as a
// child, would refuse a compressed part. Its 100 KB argument arrives as JSON, within the server's default limits.
{
	const server = createHost<P>({
		principal: { kind: "server" },
		compression: nodeCompression,
		onError: console.error,
	});
	await server.load([{ name: "@example/conversation", facet }], context);
	const client = createHost<P>({ compression: nodeCompression, onError: console.error });
	await client.load([], context);
	const [a, b] = memoryLinkPair();
	const bytes = { received: 0 };
	server.accept(counted(a, bytes), { principal: { kind: "user" } }, context);
	client.connect(b, { principal: { kind: "server" } }, context);
	const conversation = await client.get(Conversation, { id: "c4" }, context);
	await conversation.append({ id: "big", text: text(0).repeat(100) }, context);
	console.log(
		`a compressing client's 100 KB argument: ${(bytes.received / 1024).toFixed(1)} KiB received by the server`,
	);
	await client.close(context);
	await server.close(context);
}
