// Benchmark of binding state-only references (decision "Events: fire-and-forget members": contracts without event
// members pay nothing for events per binding): a same-host reference got and released on a live local object; a remote
// reference got and released over a memory link (its hold, `bound` and `release`); and a remote reference rebound by its
// provider (`loading`, then a fresh `bound`, applied and acknowledged). Time and heap allocated per step, medians of
// seven bursts. The same script runs unchanged against a checkout of an earlier commit (a git worktree) for a baseline.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/state-binding.ts
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { hostKind, int, local, remote, str } from "../../src/contracts/index.ts";
import { PROTOCOL_VERSION } from "../../src/data/internal.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { binaryCodec, memoryLinkPair } from "../../src/link/index.ts";
import { constant } from "../../src/state/index.ts";

const STEPS = 5_000;
const RUNS = 7;

type P = { kind: "owner" } | { kind: "server" };

const Server = hostKind("server");

/** A state-only local type: one count. */
const Counter = local("bench.counter", { version: 1, params: { id: str() }, members: { n: int() } });

/** A state-only remote type: one count. */
const View = remote("bench.view", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: { v: { state: { n: int() } } },
});

const facet = defineFacet<P>((host) => {
	host.serve(Counter, () => ({ n: constant(1) }));
	host.serve(View, () => ({ variant: "v", members: { n: constant(1) } }));
});

/** Median time (µs) and heap (B) per step of `step`, after a warm-up burst. */
async function measure(label: string, step: () => Promise<void>): Promise<string> {
	for (let index = 0; index < 500; index++) await step();
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
	return `| ${label} | ${median(times).toFixed(2)} µs | ${Math.round(median(heaps))} B |`;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

/** A same-host reference to a live local object, got and released. */
async function sameHost(): Promise<string> {
	const host = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	await host.load([{ name: "@bench/app", facet }], context);
	const kept = await host.get(Counter, { id: "a" }, context);
	const result = await measure("same host: get and release", async () => {
		(await host.get(Counter, { id: "a" }, context)).release();
	});
	kept.release();
	return result;
}

/** A remote reference over a memory link, got and released (its object kept live by another reference). */
async function overLink(): Promise<string> {
	const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	await server.load([{ name: "@bench/app", facet }], context);
	const client = createHost<P>({ onError: () => {} });
	await client.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: { kind: "owner" } }, context);
	client.connect(b, { principal: { kind: "server" } }, context);
	const kept = await client.get(View, { id: "a" }, context);
	const result = await measure("over a link: get and release", async () => {
		(await client.get(View, { id: "a" }, context)).release();
	});
	kept.release();
	return result;
}

/** A remote reference rebound by a raw provider: `loading`, then a fresh `bound`, each step awaited until acknowledged. */
async function rebound(): Promise<string> {
	const client = createHost<P>({ onError: () => {} });
	await client.load([], context);
	const [a, b] = memoryLinkPair();
	client.connect(a, { principal: { kind: "server" } }, context);
	let hold = -1;
	let acked: (() => void) | undefined;
	b.onMessage((bytes) => {
		const message = binaryCodec.decode(bytes);
		if (message.kind === "hold") hold = message.hold;
		if (message.kind === "ack") acked?.();
	});
	b.send(binaryCodec.encode({ kind: "hello", protocol: PROTOCOL_VERSION, incarnation: INCARNATION, calls: 256 }));
	const bound = (): void =>
		b.send(
			binaryCodec.encode({
				kind: "bound",
				holds: [{ hold, variant: 0, members: [{ member: 0, value: "1" }], failed: [] }],
			}),
		);
	const got = client.get(View, { id: "a" }, context);
	while (hold === -1) await new Promise((resolve) => setImmediate(resolve));
	bound();
	const view = await got;
	const result = await measure("over a link: rebound (loading, bound)", async () => {
		const ack = new Promise<void>((resolve) => {
			acked = resolve;
		});
		b.send(binaryCodec.encode({ kind: "loading", hold }));
		bound();
		await ack;
	});
	view.release();
	return result;
}

const INCARNATION = "00000000-0000-7000-8000-000000000001";

console.log("| State-only reference | Per step | Heap per step |");
console.log("| --- | --- | --- |");
console.log(await sameHost());
console.log(await overLink());
console.log(await rebound());
process.exit(0);
