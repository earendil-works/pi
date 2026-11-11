// Benchmark of events (decision "Events: fire-and-forget members"): the cost of one emit, flushed and delivered to its
// holders' listeners, with 0, 1, 10 and 70 holders, each a client host over its own memory link; with 10 holders of an
// older version (one mapping per emit); and through a relay (tabs on a server, the object on a worker behind a route
// link). Each step emits one paddle sample and waits until every listener got it; time per step (median of seven
// bursts) and heap allocated per step with the provider's in-memory telemetry adapter (encodes per emit: its
// `chord.events.encodes`) and with the NOOP adapter (none), and the bytes of one event message.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/events.ts
import { performance } from "node:perf_hooks";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { type EventSource, evolve, hostKind, num, obj, remote, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { binaryCodec, memoryLinkPair } from "../../src/link/index.ts";
import { jsonPart } from "../../src/link/internal.ts";

const STEPS = 2_000;
const RUNS = 7;

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

type P = { kind: "owner" } | { kind: "server" } | { kind: "worker" };

const Paddle = obj({ peer: str(), t: num(), y: num() });

const Match = remote("bench.match", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: { player: { events: { paddle: Paddle } } },
});

/** The paddle gains a velocity; version 1 consumers get it mapped away. */
const MatchV2 = evolve(Match, (e) => e.event("player", "paddle", obj({ peer: str(), t: num(), y: num(), v: num() })));

/** The same object placed on a worker (a session), reached through the server's relay. */
const Placed = remote("bench.placed", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { player: { events: { paddle: Paddle } } },
});

/** What a run measures: holders of the current version, of an older one, or through a relay. */
type Kind = "current" | "older" | "relay";

/** The provider host serving the matches, its sources (the last one emits), and its telemetry. */
async function provider(
	address: ReturnType<typeof Server> | ReturnType<typeof Session>,
	telemetry: InMemoryTelemetryContext | undefined,
) {
	const sources: EventSource<{ peer: string; t: number; y: number; v?: number }>[] = [];
	const host = createHost<P>({ address, principal: { kind: "server" }, telemetry, onError: () => {} });
	const facet = defineFacet<P>((h) => {
		h.serve(
			MatchV2,
			(_, _principal, self) => {
				const paddle = self.events<{ peer: string; t: number; y: number; v: number }>();
				sources.push(paddle);
				return { variant: "player", members: { paddle } };
			},
			{ accepts: { 1: { events: { player: { paddle: ({ peer, t, y }) => ({ peer, t, y }) } } } } },
		);
		h.serve(Placed, (_, _principal, self) => {
			const paddle = self.events<{ peer: string; t: number; y: number }>();
			sources.push(paddle);
			return { variant: "player", members: { paddle } };
		});
	});
	return { host, sources, facet };
}

/** The provider's telemetry adapter: the in-memory one (encodes counted), or none (the NOOP adapter). */
type Adapter = "in-memory" | "noop";

/**
 * `holders` client hosts each holding the match over its own link, every listener counting into `received`; the
 * provider with `adapter`.
 */
async function setUp(kind: Kind, holders: number, adapter: Adapter) {
	// The NOOP adapter (none) records nothing: its rows show what an emit costs without telemetry.
	const telemetry = adapter === "noop" ? undefined : new InMemoryTelemetryContext();
	const server = await provider(Server(), telemetry);
	let source = (): EventSource<{ peer: string; t: number; y: number; v?: number }> => server.sources.at(-1)!;
	if (kind === "relay") {
		const worker = await provider(Session({ id: "m" }), new InMemoryTelemetryContext());
		server.host.route(
			Session,
			{
				authorize: () => true,
				resolve: async () => {
					const [a, b] = memoryLinkPair();
					worker.host.connect(b, { principal: { kind: "server" }, trusted: true }, context);
					return { link: a, principal: { kind: "worker" }, trusted: true };
				},
			},
			context,
		);
		await worker.host.load([{ name: "@bench/worker", facet: worker.facet }], context);
		source = () => worker.sources.at(-1)!;
	}
	await server.host.load([{ name: "@bench/server", facet: server.facet }], context);
	const counter = { received: 0 };
	const clients: Host<P>[] = [];
	for (let index = 0; index < holders; index++) {
		const client = createHost<P>({ onError: () => {} });
		await client.load([], context);
		const [a, b] = memoryLinkPair();
		server.host.accept(a, { principal: { kind: "owner" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		const Type = kind === "older" ? Match : kind === "relay" ? Placed : MatchV2;
		const ref = (await client.get(Type, { id: "m" }, context)) as unknown as {
			paddle: { on(listener: () => void, ctx: typeof context): Promise<unknown> };
		};
		await ref.paddle.on(() => void counter.received++, context);
		clients.push(client);
	}
	if (holders === 0) {
		// The object lives while referenced: the server's own reference keeps it, without listeners.
		await server.host.get(MatchV2, { id: "m" }, context);
	}
	return { server, source, counter, telemetry, clients };
}

/** One step: an emit, then turns until every holder's listener got it. */
async function step(
	source: () => EventSource<{ peer: string; t: number; y: number; v?: number }>,
	counter: { received: number },
	holders: number,
	index: number,
): Promise<void> {
	const target = counter.received + holders;
	source().emit({ peer: "p", t: index, y: index / 7, v: 1 });
	do await new Promise((resolve) => setImmediate(resolve));
	while (counter.received < target);
}

/** Median time (µs) and heap (B) per step, encodes per emit, for `kind` with `holders` and the provider's `adapter`. */
async function measure(kind: Kind, holders: number, adapter: Adapter = "in-memory"): Promise<string> {
	const { source, counter, telemetry } = await setUp(kind, holders, adapter);
	for (let index = 0; index < 200; index++) await step(source, counter, holders, index);
	const times: number[] = [];
	const heaps: number[] = [];
	const encodesBefore = encodes(telemetry);
	for (let run = 0; run < RUNS; run++) {
		globalThis.gc?.();
		const heapBefore = process.memoryUsage().heapUsed;
		const started = performance.now();
		for (let index = 0; index < STEPS; index++) await step(source, counter, holders, index);
		times.push(((performance.now() - started) * 1000) / STEPS);
		heaps.push((process.memoryUsage().heapUsed - heapBefore) / STEPS);
	}
	const perEmit = telemetry === undefined ? "-" : (encodes(telemetry) - encodesBefore) / (RUNS * STEPS);
	const label = `${kind}, ${adapter}`;
	const heap = Math.round(median(heaps));
	return `| ${label} | ${holders} | ${median(times).toFixed(1)} µs | ${heap} B | ${perEmit} |`;
}

function encodes(telemetry: InMemoryTelemetryContext | undefined): number {
	if (telemetry === undefined) return 0;
	let total = 0;
	for (const { name, value } of telemetry.getMetrics()) if (name === "chord.events.encodes") total += value;
	return total;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

/** The bytes of one event message of one paddle sample with the binary codec. */
function messageBytes(): number {
	const value = jsonPart({ peer: "p", t: 1_762_819_200_123.5, y: 0.42857142857142855 });
	return binaryCodec.encode({ kind: "event", events: [{ hold: 0, member: 0, at: 1_762_819_200_123, value }] })
		.byteLength;
}

console.log(`one event message of a paddle sample: ${messageBytes()} B (binary codec)`);
console.log("| Holders, provider's adapter | Count | Per emit, delivered | Heap per emit | Encodes per emit |");
console.log("| --- | --- | --- | --- | --- |");
for (const holders of [0, 1, 10, 70]) console.log(await measure("current", holders));
console.log(await measure("older", 10));
console.log(await measure("relay", 10));
for (const holders of [0, 1, 10]) console.log(await measure("current", holders, "noop"));
process.exit(0);
