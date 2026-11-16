// Benchmark of remote references sharing one wire hold (decision "References share one wire hold"): a first reference
// over a memory link got and released (a hold, its `bound`, its `release`); a reference joining a held object got and
// released (no message); a commit fanned out to ten references of one object (time, bytes on the wire, encodes); and
// the heap retained per reference held. Time and the observed heap growth per step (`heapUsed` after a burst minus
// before it, divided by its steps: not allocated bytes, a collection may run inside a burst) are medians of seven bursts
// after a warm-up. The same
// script runs unchanged against a checkout of an earlier commit (a git worktree) for a baseline, where every reference
// is its own hold.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/shared-holds.ts

import { performance } from "node:perf_hooks";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { hostKind, int, method, obj, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host, type Reference } from "../../src/host/index.ts";
import { type Link, memoryLinkPair } from "../../src/link/index.ts";

const STEPS = 2_000;
const RUNS = 7;
const FAN_OUT = 10;
const RETAINED = 1_000;

type P = { kind: "owner" } | { kind: "server" };

const Server = hostKind("server");

/** A remote counter: its count, and a method that adds one. */
const Counter = remote("bench.shared-counter", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: { v: { state: { count: int() }, methods: { bump: method() } } },
});

type Live = Extract<Reference<typeof Counter>, { readonly variant: "v" }>;

const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

const facet = defineFacet<P>((host) =>
	host.serve(Counter, (_, _principal, self) => {
		const count = self.state(Count);
		return {
			variant: "v",
			members: {
				count: self.derive([count], ([doc]) => doc.n),
				bump: async (ctx) => {
					await count.change((draft) => void draft.n++, ctx);
					return null;
				},
			},
		};
	}),
);

/** `link` with the bytes it sends added to `sent.bytes`. */
function counted(link: Link, sent: { bytes: number }): Link {
	return {
		send: (message) => {
			sent.bytes += message.byteLength;
			link.send(message);
		},
		onMessage: (listener) => link.onMessage(listener),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}

/** A server and a client over a memory link; `sent` counts the bytes the server sends; its adapter counts encodes. */
async function linked(): Promise<{ server: Host<P>; client: Host<P>; sent: { bytes: number }; encodes: () => number }> {
	const telemetry = new InMemoryTelemetryContext();
	const server = createHost<P>({ address: Server(), principal: { kind: "server" }, telemetry, onError: () => {} });
	await server.load([{ name: "@bench/app", facet }], context);
	const client = createHost<P>({ onError: () => {} });
	await client.load([], context);
	const sent = { bytes: 0 };
	const [a, b] = memoryLinkPair();
	server.accept(counted(a, sent), { principal: { kind: "owner" } }, context);
	client.connect(b, { principal: { kind: "server" } }, context);
	const encodes = (): number =>
		telemetry
			.getMetrics()
			.filter(({ name }) => name === "chord.link.encodes")
			.reduce((sum, { value }) => sum + value, 0);
	return { server, client, sent, encodes };
}

/** Median time (µs) and observed heap growth (B) per step of `step`, after a warm-up burst (GC may run inside one). */
async function measure(step: () => Promise<void>): Promise<{ time: number; heap: number }> {
	for (let index = 0; index < 200; index++) await step();
	const times: number[] = [];
	const heaps: number[] = [];
	for (let run = 0; run < RUNS; run++) {
		globalThis.gc?.();
		const heap = process.memoryUsage().heapUsed;
		const started = performance.now();
		for (let index = 0; index < STEPS; index++) await step();
		times.push(((performance.now() - started) * 1000) / STEPS);
		heaps.push((process.memoryUsage().heapUsed - heap) / STEPS);
	}
	return { time: median(times), heap: median(heaps) };
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

function row(label: string, { time, heap }: { time: number; heap: number }, extra = ""): string {
	return `| ${label} | ${time.toFixed(2)} µs | ${Math.round(heap)} B |${extra}`;
}

/** A first reference, got and released: its own hold each time. */
async function first(): Promise<string> {
	const { client, sent } = await linked();
	let id = 0;
	const before = sent.bytes;
	const result = await measure(async () => {
		(await client.get(Counter, { id: `${id++ % 64}` }, context)).release();
	});
	const steps = 200 + RUNS * STEPS;
	return row("first reference: get and release", result, ` ${Math.round((sent.bytes - before) / steps)} B |`);
}

/** A reference to an object another reference holds, got and released. */
async function join(): Promise<string> {
	const { client, sent } = await linked();
	const kept = await client.get(Counter, { id: "a" }, context);
	const before = sent.bytes;
	const result = await measure(async () => {
		(await client.get(Counter, { id: "a" }, context)).release();
	});
	const steps = 200 + RUNS * STEPS;
	kept.release();
	return row("joining reference: get and release", result, ` ${Math.round((sent.bytes - before) / steps)} B |`);
}

/** One commit seen by every one of `FAN_OUT` references of one object (each awaits its value). */
async function fanOut(): Promise<string> {
	const { client, sent, encodes } = await linked();
	const refs: Live[] = [];
	for (let index = 0; index < FAN_OUT; index++) refs.push((await client.get(Counter, { id: "a" }, context)) as Live);
	const watches = await Promise.all(refs.map((ref) => ref.count.watch(context)));
	let target = refs[0]!.count.value;
	const [bytes, encoded] = [sent.bytes, encodes()];
	const result = await measure(async () => {
		target++;
		await refs[0]!.bump(context);
		while (refs.some((ref) => ref.count.value !== target)) await new Promise((resolve) => setImmediate(resolve));
	});
	const steps = 200 + RUNS * STEPS;
	const perCommit = ` ${Math.round((sent.bytes - bytes) / steps)} B, ${((encodes() - encoded) / steps).toFixed(1)} encodes |`;
	for (const watch of watches) await watch.stop();
	for (const ref of refs) ref.release();
	return row(`a commit to ${FAN_OUT} references of one object (with its call)`, result, perCommit);
}

/** The heap a held reference retains, `RETAINED` of them to one object (after the first). */
async function retained(): Promise<string> {
	const { client } = await linked();
	const kept = await client.get(Counter, { id: "a" }, context);
	globalThis.gc?.();
	const heap = process.memoryUsage().heapUsed;
	const refs: Live[] = [];
	for (let index = 0; index < RETAINED; index++) refs.push((await client.get(Counter, { id: "a" }, context)) as Live);
	globalThis.gc?.();
	const per = (process.memoryUsage().heapUsed - heap) / RETAINED;
	for (const ref of refs) ref.release();
	kept.release();
	return `| ${RETAINED} references held: heap per reference | | ${Math.round(per)} B | |`;
}

console.log("| Step | Per step | Heap growth per step | Server's bytes (per step) |");
console.log("| --- | --- | --- | --- |");
console.log(await first());
console.log(await join());
console.log(await fanOut());
console.log(await retained());
process.exit(0);
