// Light benchmarks of remote objects over one memory link (slices 3a, 3b), per codec side by side: wire bytes per
// message; compute (encode and decode time per message, commit-to-frame end to end); memory (heap allocated per message
// while encoding and decoding, retained per hold); drops (3b: reconnects re-holding 1 and 100 references, 1,000 calls
// parked while the link is down). Payloads are modelled on p2: a notes list, a 500 KB conversation document, a reply
// streamed token by token, calls with and without bytes.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/next/bench/links.ts
import { GCProfiler } from "node:v8";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, type Context, withTelemetry } from "../../../src/context/index.ts";
import { arr, bytes, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host, type RefState } from "../../../src/next/host/index.ts";
import { type Codec, type Link, memoryLinkPair } from "../../../src/next/link/index.ts";
import { binaryCodec, type Message, textCodec } from "../../../src/next/link/internal.ts";
import type { NativeWatchable } from "../../../src/watch.ts";

type P = { kind: "owner" } | { kind: "server" };

const Entry = obj({ id: int(), text: str(), author: str(), at: int() });
const Shape = obj({ entries: arr(Entry) });

/** The shared store: one document of entries, and the writes the benchmark makes. */
const Store = local("bench.store", {
	version: 1,
	params: { name: str() },
	members: {
		doc: Shape,
		append: method(Entry),
		edit: method(obj({ index: int(), text: str() })),
		remove: method(int()),
		stream: method(str()),
	},
});

/** The remote view a client holds: the store's document as it is. */
const View = remote("bench.view", {
	version: 1,
	params: { name: str() },
	variants: { owner: { state: { doc: Shape } } },
});

/** A file service: a call with a small argument, and one with bytes. */
const Files = remote("bench.files", {
	version: 1,
	params: {},
	variants: {
		owner: { methods: { ping: method(obj({ n: int() }), int()), put: method(obj({ data: bytes() }), int()) } },
	},
});

const Doc = defineState("doc", { schema: Shape, version: 1, initial: () => ({ entries: [] }) });

/** The `n` of every `ping` in the order the provider ran them. */
const pings: number[] = [];

const facet = defineFacet<P>((host) => {
	host.serve(Store, (_, self) => {
		const doc = self.state(Doc);
		const change = (
			fn: (draft: { entries: { id: number; text: string; author: string; at: number }[] }) => void,
			ctx: Context,
		) => doc.change((draft) => void fn(draft), ctx).then(() => null);
		return {
			doc,
			append: (entry, ctx) => change((d) => void d.entries.push(entry), ctx),
			edit: ({ index, text }, ctx) =>
				change((d) => {
					d.entries[index]!.text = text;
				}, ctx),
			remove: (index, ctx) => change((d) => void d.entries.splice(index, 1), ctx),
			stream: (token, ctx) =>
				change((d) => {
					d.entries[d.entries.length - 1]!.text += token;
				}, ctx),
		};
	});
	host.serve(View, ({ name }, _principal, self) => ({
		variant: "owner",
		members: { doc: self.get(Store, { name }).doc },
	}));
	host.serve(Files, () => ({
		variant: "owner",
		members: {
			ping: async ({ n }) => {
				pings.push(n);
				return n + 1;
			},
			put: async ({ data }) => data.byteLength,
		},
	}));
});

/** A link end counting what it sends and keeping the last message. */
function counted(link: Link): Link & { bytes: number; messages: number; last: Uint8Array | undefined } {
	const counting = {
		bytes: 0,
		messages: 0,
		last: undefined as Uint8Array | undefined,
		send(message: Uint8Array) {
			counting.bytes += message.byteLength;
			counting.messages++;
			counting.last = message;
			link.send(message);
		},
		onMessage: (listener: (message: Uint8Array) => void) => link.onMessage(listener),
		close: () => link.close(),
		onClose: (listener: () => void) => link.onClose(listener),
	};
	return counting;
}

const telemetry = new InMemoryTelemetryContext();
const span = await telemetry.startSpan({ name: "bench" }, (s) => s);
const counting = withTelemetry(span, BACKGROUND_CONTEXT);

/** The encodes counted so far (the in-memory adapter records each add). */
const encodes = (): number =>
	telemetry
		.getMetrics()
		.filter(({ name }) => name === "chord.link.encodes")
		.reduce((sum, { value }) => sum + value, 0);

type Entry = { id: number; text: string; author: string; at: number };

function entry(id: number, length: number): Entry {
	return { id, text: "x".repeat(length), author: "mario", at: 1_700_000_000_000 + id };
}

const notes = (): Entry[] => Array.from({ length: 1_000 }, (_, id) => entry(id, 80));

const document = (): Entry[] => Array.from({ length: 500 }, (_, id) => entry(id, 960));

/**
 * A server with `entries` in store `name`, a client connected over a counted link in `codec`. `metered: false` leaves
 * telemetry out (the in-memory adapter keeps every record, which a memory measurement would count).
 */
async function setup(name: string, entries: Entry[], codec: Codec, metered = true) {
	const context = metered ? counting : BACKGROUND_CONTEXT;
	const server = createHost<P>({
		principal: { kind: "server" },
		telemetry: metered ? telemetry : undefined,
		onError: console.error,
	});
	await server.load([{ name: "@bench/app", facet }], context);
	const store = await server.get(Store, { name }, context);
	for (const item of entries) await store.append(item, context);
	const [a, b] = memoryLinkPair();
	const down = counted(a);
	const up = counted(b);
	server.accept(down, { principal: { kind: "owner" }, codec }, context);
	const client = createHost<P>({ onError: console.error });
	client.connect(up, { principal: { kind: "server" }, codec }, context);
	await client.load([], context);
	const close = async () => {
		await client.close(context);
		await server.close(context);
	};
	return { server, client, store, down, up, close, context };
}

const gc = (globalThis as { gc?: () => void }).gc!;

/** Heap and `ArrayBuffer` bytes: the message bytes themselves live outside the heap. */
type Memory = { readonly heap: number; readonly arrayBuffers: number };

/** Waits until queued deliveries ran and collects garbage, repeatedly, then returns the memory in use. */
async function settledMemory(): Promise<Memory> {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		gc();
	}
	const { heapUsed, arrayBuffers } = process.memoryUsage();
	return { heap: heapUsed, arrayBuffers };
}

/** Heap bytes `work` allocated: the growth plus what the collections it caused freed. */
function allocated(work: () => void): number {
	gc();
	const before = process.memoryUsage().heapUsed;
	const profiler = new GCProfiler();
	profiler.start();
	work();
	const after = process.memoryUsage().heapUsed;
	let freed = 0;
	for (const { beforeGC, afterGC } of profiler.stop().statistics) {
		freed += beforeGC.heapStatistics.usedHeapSize - afterGC.heapStatistics.usedHeapSize;
	}
	return after - before + freed;
}

/**
 * `ArrayBuffer` bytes one encoded message keeps alive (its backing store, which may be larger than the message), over
 * `runs` messages kept at once. Freed buffers are not reported reliably during a loop, so this measures what is kept.
 */
async function retainedBuffers(codec: Codec, message: Message, runs: number): Promise<number> {
	const before = (await settledMemory()).arrayBuffers;
	const kept = Array.from({ length: runs }, () => codec.encode(message));
	const after = (await settledMemory()).arrayBuffers;
	return kept.length === runs ? (after - before) / runs : 0;
}

/**
 * One message through a codec, `runs` times: wire bytes, encode and decode time per message, and heap allocated per
 * message while encoding and decoding.
 */
function codecRun(codec: Codec, message: Message, runs: number) {
	const bytes = codec.encode(message);
	for (let i = 0; i < 100; i++) codec.decode(codec.encode(message));
	// The fastest of five loops: one loop of a microsecond-sized message is at the mercy of the collector and the JIT.
	let encode = Number.POSITIVE_INFINITY;
	let decode = Number.POSITIVE_INFINITY;
	for (let repeat = 0; repeat < 5; repeat++) {
		const t0 = performance.now();
		for (let i = 0; i < runs; i++) codec.encode(message);
		const t1 = performance.now();
		for (let i = 0; i < runs; i++) codec.decode(bytes);
		const t2 = performance.now();
		encode = Math.min(encode, (t1 - t0) / runs);
		decode = Math.min(decode, (t2 - t1) / runs);
	}
	const heap = allocated(() => {
		for (let i = 0; i < runs; i++) codec.decode(codec.encode(message));
	});
	return { bytes: bytes.byteLength, encode, decode, heap: heap / runs };
}

const CODECS = [binaryCodec, textCodec];

/** Results by row label, one value per codec. */
const table = new Map<string, string[]>();

const record = (label: string, codec: Codec, value: string): void => {
	const row = table.get(label) ?? [];
	row[CODECS.indexOf(codec)] = value;
	table.set(label, row);
};

const ms = (value: number) => `${value.toFixed(3)} ms`;
const us = (value: number) => `${(value * 1000).toFixed(1)} µs`;
const kb = (value: number) => `${(value / 1024).toFixed(1)} KiB`;
const b = (value: number) => (value >= 10_240 ? kb(value) : `${value.toFixed(0)} B`);

/** Records a captured message's codec run under `label`. */
async function codecRows(label: string, codec: Codec, message: Message, runs: number): Promise<void> {
	const run = codecRun(codec, message, runs);
	record(`${label}: wire bytes`, codec, b(run.bytes));
	record(`${label}: encode / decode`, codec, `${us(run.encode)} / ${us(run.decode)}`);
	record(`${label}: heap per encode + decode`, codec, b(run.heap));
	record(`${label}: array buffer kept per encoded message`, codec, b(await retainedBuffers(codec, message, 50)));
}

/** A snapshot over a link: hold to live, then the captured `bound` through the codec alone. */
async function snapshot(label: string, codec: Codec, entries: Entry[]): Promise<void> {
	const { client, down, close } = await setup(label, entries, codec);
	let start = performance.now();
	// The first hold also activates the view; it stays held, so later holds measure the snapshot path alone.
	await client.get(View, { name: label }, counting);
	record(`${label}: first hold to live (activation, one sample)`, codec, ms(performance.now() - start));
	const runs = 100;
	start = performance.now();
	for (let i = 0; i < runs; i++) (await client.get(View, { name: label }, counting)).release();
	record(`${label}: hold to live (two hops, mean of ${runs})`, codec, ms((performance.now() - start) / runs));
	await codecRows(`${label}: snapshot`, codec, codec.decode(down.last!), 1_000);
	await close();
}

/** One commit per run: commit-to-frame, bytes and messages per commit, encodes per hold; then its message alone. */
async function commits(
	label: string,
	codec: Codec,
	write: (store: Awaited<ReturnType<typeof setup>>["store"], i: number) => Promise<unknown>,
): Promise<void> {
	const { client, store, down, close } = await setup(label, notes(), codec);
	const view = await client.get(View, { name: label }, counting);
	const watch = await view.doc.watch(counting);
	let frame: () => void = () => {};
	watch.start(async () => frame());
	const runs = 1_000;
	const [messages0, encodes0] = [down.messages, encodes()];
	let total = 0;
	for (let i = 0; i < runs; i++) {
		const arrived = new Promise<void>((resolve) => {
			frame = resolve;
		});
		const start = performance.now();
		await write(store, i);
		await arrived;
		total += performance.now() - start;
	}
	record(`${label}: commit to frame`, codec, ms(total / runs));
	record(
		`${label}: messages per commit, encodes per hold`,
		codec,
		`${(down.messages - messages0) / runs}, ${(encodes() - encodes0) / runs}`,
	);
	await codecRows(`${label}: state message`, codec, codec.decode(down.last!), 10_000);
	await close();
}

/** A streamed reply: 2,000 small text appends to one entry. */
async function stream(codec: Codec): Promise<void> {
	const { client, store, down, close } = await setup("stream", [entry(0, 0)], codec);
	const view = await client.get(View, { name: "stream" }, counting);
	const watch = await view.doc.watch(counting);
	let frames = 0;
	const done = Promise.withResolvers<void>();
	watch.start(async () => {
		if (++frames === 2_000) done.resolve();
	});
	const bytes0 = down.bytes;
	const start = performance.now();
	for (let i = 0; i < 2_000; i++) await store.stream(" tok", counting);
	await done.promise;
	record("streamed reply, 2,000 appends: time per append", codec, ms((performance.now() - start) / 2_000));
	record(
		"streamed reply: bytes per append, total",
		codec,
		`${((down.bytes - bytes0) / 2_000).toFixed(0)} B, ${kb(down.bytes - bytes0)}`,
	);
	await codecRows("streamed token", codec, codec.decode(down.last!), 10_000);
	await close();
}

/** One trial: the memory retained per hold and the messages of one commit, with `holds` holds on one link. */
async function holdTrial(
	codec: Codec,
	holds: number,
): Promise<{ readonly perHold: Memory; readonly messages: number }> {
	const name = `holds ${holds}`;
	const { client, store, down, close } = await setup(name, notes(), codec, false);
	const before = await settledMemory();
	const views = [];
	for (let i = 0; i < holds; i++) views.push(await client.get(View, { name }, BACKGROUND_CONTEXT));
	await store.edit({ index: 1, text: "warm" }, BACKGROUND_CONTEXT);
	const after = await settledMemory();
	const messages0 = down.messages;
	await store.edit({ index: 2, text: "changed" }, BACKGROUND_CONTEXT);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const messages = down.messages - messages0;
	await close();
	const perHold = {
		heap: (after.heap - before.heap) / holds,
		arrayBuffers: (after.arrayBuffers - before.arrayBuffers) / holds,
	};
	return { perHold, messages };
}

/** Calls: a small argument, and a 1 MiB `bytes()` argument; round trips, then the call and result messages alone. */
async function calls(codec: Codec): Promise<void> {
	const { client, down, up, close } = await setup("calls", [], codec);
	const files = await client.get(Files, {}, counting);
	let start = performance.now();
	for (let i = 0; i < 1_000; i++) await files.ping({ n: i }, counting);
	record("call, small argument: round trip", codec, ms((performance.now() - start) / 1_000));
	await codecRows("call, small argument: call message", codec, codec.decode(up.last!), 10_000);
	await codecRows("call, small argument: result message", codec, codec.decode(down.last!), 10_000);
	const data = new Uint8Array(1024 * 1024);
	start = performance.now();
	for (let i = 0; i < 50; i++) await files.put({ data }, counting);
	record("call, 1 MiB bytes argument: round trip", codec, ms((performance.now() - start) / 50));
	await codecRows("call, 1 MiB bytes argument: call message", codec, codec.decode(up.last!), 1_000);
	await close();
}

/**
 * Drops the client's parent link (the server's end closes it) and waits until the client saw the close; then connects
 * a new counted link and returns it with the time it was connected.
 */
async function relink(server: Host<P>, client: Host<P>, down: Link, codec: Codec) {
	down.close();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const [a, b] = memoryLinkPair();
	const next = { down: counted(a), up: counted(b) };
	const start = performance.now();
	server.accept(next.down, { principal: { kind: "owner" }, codec }, BACKGROUND_CONTEXT);
	client.connect(next.up, { principal: { kind: "server" }, codec }, BACKGROUND_CONTEXT);
	return { ...next, start };
}

/** Resolves when `state` is live. */
async function live(state: NativeWatchable<RefState>): Promise<void> {
	if (state.value.kind === "live") return;
	const watch = await state.watch(BACKGROUND_CONTEXT);
	const done = Promise.withResolvers<void>();
	watch.start(async (call) => {
		if (call.kind === "value" && call.value.kind === "live") done.resolve();
	});
	await done.promise;
	await watch.stop();
}

/**
 * Reconnects with `references` held references of the 1,000-item view (one provider object, a hold each): time from
 * `connect` to every reference live again, and the bytes of the re-holds both ways; the mean of `runs` reconnects.
 */
async function reconnects(codec: Codec, references: number, runs: number): Promise<void> {
	const name = `reconnect ${references}`;
	const { server, client, down, close } = await setup(name, notes(), codec, false);
	const views = [];
	for (let i = 0; i < references; i++) views.push(await client.get(View, { name }, BACKGROUND_CONTEXT));
	let link = down;
	let time = 0;
	let bytes = { down: 0, up: 0 };
	for (let run = 0; run < runs; run++) {
		const next = await relink(server, client, link, codec);
		await Promise.all(views.map((view) => live(view.state)));
		time += performance.now() - next.start;
		bytes = { down: next.down.bytes, up: next.up.bytes };
		link = next.down;
	}
	const label = `reconnect, ${references} reference(s) of 1,000 items`;
	record(`${label}: time to all live (mean of ${runs})`, codec, ms(time / runs));
	record(`${label}: bytes down / up`, codec, `${b(bytes.down)} / ${b(bytes.up)}`);
	await close();
}

/** 1,000 calls made while the link is down, flushed on reconnect: time from `connect` to the last result, and order. */
async function parkedCalls(codec: Codec): Promise<void> {
	const { server, client, down, close } = await setup("parked", [], codec, false);
	const files = await client.get(Files, {}, BACKGROUND_CONTEXT);
	let link = down;
	let time = 0;
	let ordered = true;
	const runs = 10;
	for (let run = 0; run < runs; run++) {
		pings.length = 0;
		const next = await relink(server, client, link, codec);
		// The link is connected but not yet live: every call below parks until the re-hold is bound.
		const results = await Promise.all(Array.from({ length: 1_000 }, (_, n) => files.ping({ n }, BACKGROUND_CONTEXT)));
		time += performance.now() - next.start;
		ordered &&= pings.every((n, index) => n === index) && results.every((result, index) => result === index + 1);
		link = next.down;
	}
	record("1,000 calls parked while down, flushed on reconnect: time to the last result", codec, ms(time / runs));
	record("1,000 parked calls: run in the order they were made", codec, ordered ? "yes" : "no");
	await close();
}

for (const codec of CODECS) {
	// Warm-up: the first run pays for compilation.
	await snapshot("warm-up", codec, notes());
	await snapshot("notes list of 1,000 items", codec, notes());
	await snapshot("500 KB document", codec, document());
	await commits("one appended item", codec, (store, i) => store.append(entry(10_000 + i, 80), counting));
	await commits("one changed field", codec, (store, i) => store.edit({ index: 500, text: `edit ${i}` }, counting));
	await commits("one removed item", codec, (store) => store.remove(0, counting));
	await stream(codec);
	for (const holds of [1, 10]) {
		// The median of seven trials: a single hold is small next to the collector's noise.
		const trials: Awaited<ReturnType<typeof holdTrial>>[] = [];
		for (let i = 0; i < 7; i++) trials.push(await holdTrial(codec, holds));
		const median = (of: (memory: Memory) => number) =>
			trials.map(({ perHold }) => of(perHold)).sort((a, b) => a - b)[3]!;
		const retained = `${kb(median(({ heap }) => heap))} / ${b(median(({ arrayBuffers }) => arrayBuffers))}`;
		record(`${holds} hold(s) of 1,000 items: heap / array buffers retained per hold (both ends)`, codec, retained);
		record(`${holds} hold(s): messages per commit`, codec, `${trials[0]!.messages}`);
	}
	await calls(codec);
	await reconnects(codec, 1, 20);
	await reconnects(codec, 100, 5);
	await parkedCalls(codec);
}

const rows = [...table].filter(([label]) => !label.startsWith("warm-up"));
const width = Math.max(...rows.map(([label]) => label.length));
console.log(`| ${"Case".padEnd(width)} | binary | text |`);
console.log(`| ${"-".repeat(width)} | --- | --- |`);
for (const [label, [binary, text]] of rows) console.log(`| ${label.padEnd(width)} | ${binary} | ${text} |`);
