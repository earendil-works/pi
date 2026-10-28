// Light benchmark of compression at the origin (slice 4b): a 500 KB snapshot and a 1 MiB call result, uncompressed and
// deflated (level 1) by the server; their bytes on the wire, the deflate at the origin, the inflate at the owner
// (synchronous `nodeCompression`, asynchronous `DecompressionStream`), and end to end over a memory link.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/next/bench/compression.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { type Compression, type Link, memoryLinkPair } from "../../../src/next/link/index.ts";
import { DeflatedPart, inflateAsync } from "../../../src/next/link/internal.ts";
import { nodeCompression } from "../../../src/next-node/compression.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "server" };

const Entry = obj({ id: int(), text: str(), author: str(), at: int() });

const Store = local("bench.store", { version: 1, params: {}, members: { doc: obj({ entries: arr(Entry) }) } });

/** A tab's view of the 500 KB document, and a method returning 1 MiB. */
const View = remote("bench.view", {
	version: 1,
	params: {},
	variants: { owner: { state: { doc: obj({ entries: arr(Entry) }) }, methods: { export: method(undefined, str()) } } },
});

/** Words that make text compress like prose and code (about 3x at level 1), not like a repeated string. */
const WORDS = "the a model tool call file read write test error result agent session note code run build".split(" ");

/** About `length` characters of words, from a fixed pseudo-random sequence starting at `seed`. */
function prose(seed: number, length: number): string {
	let state = seed * 7919 + 1;
	const words: string[] = [];
	for (let total = 0; total < length; total += words.at(-1)!.length + 1) {
		state = (state * 1103515245 + 12345) % 2147483648;
		const word = WORDS[state % WORDS.length]!;
		words.push(state % 5 === 0 ? `${word}${state % 1000}` : word);
	}
	return words.join(" ").slice(0, length);
}

/** The 500 KB document: 500 entries of 960 characters, as in the slice 3a benchmark, with prose-like text. */
const entries = Array.from({ length: 500 }, (_, id) => ({
	id,
	text: prose(id, 960),
	author: "mario",
	at: 1_700_000_000 + id,
}));

/** The 1 MiB result. */
const RESULT = prose(1, 1024 * 1024);

const Doc = defineState("doc", { schema: obj({ entries: arr(Entry) }), version: 1, initial: () => ({ entries }) });

const facet = defineFacet<P>((host) => {
	host.serve(Store, (_, self) => ({ doc: self.state(Doc) }));
	host.serve(View, (_, _principal, self) => ({
		variant: "owner",
		members: { doc: self.get(Store, {}).doc, export: async () => RESULT },
	}));
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

/** The mean milliseconds of `runs` runs of `work`, the fastest of three such loops. */
async function mean(runs: number, work: () => unknown): Promise<number> {
	let best = Number.POSITIVE_INFINITY;
	for (let loop = 0; loop < 3; loop++) {
		const started = performance.now();
		for (let run = 0; run < runs; run++) await work();
		best = Math.min(best, (performance.now() - started) / runs);
	}
	return best;
}

const UTF8 = new TextEncoder();

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

const ms = (value: number) => `${value.toFixed(3)} ms`;

console.log(
	"| Payload | JSON | deflated (level 1) | deflate at the origin | inflate, sync (`nodeCompression`) | inflate, async (`DecompressionStream`) |",
);
console.log("| --- | --- | --- | --- | --- | --- |");
for (const [name, json] of [
	["500 KB snapshot", JSON.stringify({ entries })],
	["1 MiB result", JSON.stringify(RESULT)],
] as const) {
	const bytes = UTF8.encode(json);
	const deflated = nodeCompression.deflate(bytes);
	const deflate = await mean(20, () => nodeCompression.deflate(bytes));
	const inflate = await mean(20, () => nodeCompression.inflate(deflated, Number.POSITIVE_INFINITY));
	const inflateAsyncMs = await mean(20, () =>
		inflateAsync(new DeflatedPart(deflated), Number.POSITIVE_INFINITY, new AbortController().signal, context),
	);
	console.log(
		`| ${name} | ${kib(bytes.byteLength)} | ${kib(deflated.byteLength)} | ${ms(deflate)} | ${ms(inflate)} | ${ms(inflateAsyncMs)} |`,
	);
}

/** A server compressing with `server` and a client with `client` (none: it inflates asynchronously). */
async function linked(server: Compression | undefined, client: Compression | undefined) {
	const serverHost = createHost<P>({ principal: { kind: "server" }, compression: server, onError: console.error });
	await serverHost.load([{ name: "@bench/app", facet }], context);
	const clientHost = createHost<P>({ compression: client, onError: console.error });
	await clientHost.load([], context);
	const [a, b] = memoryLinkPair();
	const bytes = { received: 0 };
	serverHost.accept(a, { principal: { kind: "owner" } }, context);
	clientHost.connect(counted(b, bytes), { principal: { kind: "server" } }, context);
	return { server: serverHost, client: clientHost, bytes };
}

console.log();
console.log(
	"| End to end over a memory link (binary codec) | snapshot: bytes received | hold to live (mean of 20) | 1 MiB result: bytes received | call to result (mean of 20) |",
);
console.log("| --- | --- | --- | --- | --- |");
for (const [label, server, client] of [
	["uncompressed", undefined, undefined],
	["deflated, inflated synchronously (Node client)", nodeCompression, nodeCompression],
	["deflated, inflated asynchronously (browser client)", nodeCompression, undefined],
] as const) {
	const hosts = await linked(server, client);
	// Warm up: the store and the view activate once.
	(await hosts.client.get(View, {}, context)).release();
	const before = hosts.bytes.received;
	const view = await hosts.client.get(View, {}, context);
	const snapshotBytes = hosts.bytes.received - before;
	view.release();
	const hold = await mean(20, async () => (await hosts.client.get(View, {}, context)).release());
	const held = await hosts.client.get(View, {}, context);
	const beforeCall = hosts.bytes.received;
	await held.export(context);
	const resultBytes = hosts.bytes.received - beforeCall;
	const call = await mean(20, () => held.export(context));
	console.log(`| ${label} | ${kib(snapshotBytes)} | ${ms(hold)} | ${kib(resultBytes)} | ${ms(call)} |`);
	await hosts.client.close(context);
	await hosts.server.close(context);
}
