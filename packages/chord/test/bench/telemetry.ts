// Benchmark of slice 9's cost (§30): a call over a memory link with the NOOP adapter (to compare with the same script
// run on the code before slice 9: within noise is the target) and with the in-memory adapter on both hosts (spans,
// carriers and metrics recorded); and the container-width benchmark of R24 (§12): one item of a flat array of 1,000,
// 10,000 and 100,000 changed per commit, alone and with a `mapShared` derive over it (allocations and element visits per
// change). Median µs per operation over bursts, and heap allocated per operation (growth plus what the collections during
// the burst freed).
// Run by hand from packages/chord (not in CI), pinned for comparisons; `--noop` measures only the NOOP call (the part
// that runs on the code before slice 9 too, copied there):
//   taskset -c 10 node --conditions=source --experimental-strip-types --expose-gc test/bench/telemetry.ts
import { performance } from "node:perf_hooks";
import { GCProfiler } from "node:v8";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, type Context, withTelemetry } from "../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { mapShared } from "../../src/state/index.ts";

const BURSTS = 9;

const gc = (globalThis as { gc?: () => void }).gc!;

/** Median µs per operation over the bursts (after one warm-up burst), and heap bytes allocated per operation. */
async function measure(runs: number, operation: (i: number) => Promise<unknown>): Promise<string> {
	const times: number[] = [];
	let bytes = 0;
	let counted = 0;
	for (let burst = -1; burst < BURSTS; burst++) {
		gc();
		const before = process.memoryUsage().heapUsed;
		const profiler = new GCProfiler();
		profiler.start();
		const started = performance.now();
		for (let i = 0; i < runs; i++) await operation(i);
		const elapsed = performance.now() - started;
		const after = process.memoryUsage().heapUsed;
		let freed = 0;
		for (const { beforeGC, afterGC } of profiler.stop().statistics) {
			freed += beforeGC.heapStatistics.usedHeapSize - afterGC.heapStatistics.usedHeapSize;
		}
		if (burst < 0) continue;
		times.push((elapsed * 1000) / runs);
		bytes += after - before + freed;
		counted += runs;
	}
	times.sort((a, b) => a - b);
	return `${times[Math.floor(times.length / 2)]!.toFixed(2)} µs, ${Math.round(bytes / counted)} B allocated`;
}

const Server = hostKind("server");

type P = { kind: "owner" } | { kind: "server" };

/** A remote counter: `bump` returns at once, `add` commits one document change. */
const Counter = remote("bench.counter", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { owner: { state: { n: int() }, methods: { bump: method(), add: method(int(), int()) } } },
});

const Count = defineState("bench.count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

/** A server serving `Counter` and a client connected to it over a memory link, both recording to `telemetry`. */
async function linked(telemetry: InMemoryTelemetryContext | undefined) {
	const server = createHost<P>({
		address: Server(),
		principal: { kind: "server" },
		telemetry,
		onError: (error) => console.log("server", error.kind),
	});
	await server.load(
		[
			{
				name: "@bench/counter",
				facet: defineFacet<P>((h) =>
					h.serve(Counter, (_params, _principal, self) => {
						const count = self.state(Count);
						return {
							variant: "owner",
							members: {
								n: self.derive([count], ([c]) => c.n),
								bump: async () => null,
								add: async (n, ctx) => {
									await count.change((draft) => {
										draft.n += n;
									}, ctx);
									return count.value.n;
								},
							},
						};
					}),
				),
			},
		],
		BACKGROUND_CONTEXT,
	);
	const client = createHost<P>({ telemetry, onError: (error) => console.log("client", error.kind) });
	await client.load([], BACKGROUND_CONTEXT);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: { kind: "owner" } }, BACKGROUND_CONTEXT);
	client.connect(b, { principal: { kind: "server" } }, BACKGROUND_CONTEXT);
	const counter = await client.get(Counter, {}, BACKGROUND_CONTEXT);
	return { counter, close: () => Promise.all([client.close(BACKGROUND_CONTEXT), server.close(BACKGROUND_CONTEXT)]) };
}

/** A call over the link, and a call that commits, under `context`. */
async function calls(label: string, telemetry: InMemoryTelemetryContext | undefined, context: Context) {
	const { counter, close } = await linked(telemetry);
	console.log(`${label} call over a link:`, await measure(5_000, () => counter.bump(context)));
	console.log(`${label} call that commits:`, await measure(5_000, () => counter.add(1, context)));
	await close();
}

await calls("NOOP adapter,", undefined, BACKGROUND_CONTEXT);
if (!process.argv.includes("--noop")) {
	// A fresh adapter per measurement keeps the recorded spans from growing across them.
	const telemetry = new InMemoryTelemetryContext();
	await telemetry.startSpan({ name: "bench" }, (span) =>
		calls("in-memory adapter,", telemetry, withTelemetry(span, BACKGROUND_CONTEXT)),
	);
	console.log("  spans recorded:", telemetry.getSpans().length, "measurements:", telemetry.getMetrics().length);
	await containerWidth();
}

/** R24: one item of a flat array of `size` changed per commit, alone and under a `mapShared` derive. */
async function containerWidth(): Promise<void> {
	const Item = obj({ id: int(), text: str() });
	const Shape = obj({ items: arr(Item) });
	const Items = defineState("bench.items", { schema: Shape, version: 1, initial: () => ({ items: [] }) });
	const Wide = local("bench.wide", {
		version: 1,
		params: { size: int() },
		members: { visible: arr(Item), fill: method(int()), edit: method(int()) },
	});
	let visits = 0;
	// Every edit writes a new text: an unchanged value would commit nothing.
	let edits = 0;
	const host = createHost({ onError: (error) => console.log("host", error.kind) });
	await host.load(
		[
			{
				name: "@bench/wide",
				facet: defineFacet((h) =>
					h.serve(Wide, (_params, self) => {
						const items = self.state(Items);
						const visible = mapShared((item: { id: number; text: string }) => {
							visits++;
							return { id: item.id, text: item.text };
						});
						return {
							visible: self.derive([items], ([value]) => visible(value.items)),
							fill: async (size, ctx) => {
								await items.change((draft) => {
									for (let id = 0; id < size; id++) draft.items.push({ id, text: `item ${id}` });
								}, ctx);
								return null;
							},
							edit: async (index, ctx) => {
								await items.change((draft) => {
									draft.items[index]!.text = `edit ${++edits}`;
								}, ctx);
								return null;
							},
						};
					}),
				),
			},
		],
		BACKGROUND_CONTEXT,
	);
	for (const size of [1_000, 10_000, 100_000]) {
		const wide = await host.get(Wide, { size }, BACKGROUND_CONTEXT);
		await wide.fill(size, BACKGROUND_CONTEXT);
		const runs = size >= 100_000 ? 200 : 2_000;
		console.log(
			`width ${size}, one item changed:`,
			await measure(runs, (i) => wide.edit(i % size, BACKGROUND_CONTEXT)),
		);
		const watch = await wide.visible.watch(BACKGROUND_CONTEXT);
		watch.start(async () => {});
		visits = 0;
		const result = await measure(runs, (i) => wide.edit(i % size, BACKGROUND_CONTEXT));
		const perChange = visits / ((BURSTS + 1) * runs);
		console.log(
			`width ${size}, under a watched mapShared derive:`,
			result,
			`${perChange.toFixed(1)} mapper runs per change`,
		);
		await watch.stop();
		wide.release();
	}
	await host.close(BACKGROUND_CONTEXT);
}
