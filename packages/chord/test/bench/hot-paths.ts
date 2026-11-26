// Benchmark of the hot paths of admitted objects held over a link (the hot-path pass, 2026-11-26): N things whose
// admissions all derive from one source, server and client hosts in one process over an in-memory link.
//   1. hold:    N objects are held and released (activation, admission, bind over the link, teardown).
//   2. re-read: the source changes, every admission reads an equal decision (nothing may be rebuilt).
//   3. rebuild: the source changes the grant, every object is sealed, admitted again and rebound.
// Each case reports its time per object (median of the rounds) and, from 20 more rounds under the sampling heap
// profiler, what it allocates per object (objects collected meanwhile included). With `alloc` as third argument it lists the functions that
// allocate most in the rebuild.
// Run by hand from packages/chord (not in CI), pinned to one core on a shared machine:
//   taskset -c 6 node --conditions=source --experimental-strip-types test/bench/hot-paths.ts [N=170] [rounds=60] [alloc]
import { Session } from "node:inspector/promises";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, grantable, hostKind, int, local, method, obj, oneOf, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { allow, createHost, defineFacet } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { constant } from "../../src/state/index.ts";

const N = Number(process.argv[2] ?? 170);
const ROUNDS = Number(process.argv[3] ?? 60);
const LIST = process.argv[4] === "alloc";
const WARM_UP = 10;
const SAMPLED = 20;

type Principal = { kind: "server" } | { kind: "person"; id: string };

const Server = hostKind("server");
type Granted = "add" | "export" | "history";
const Name = oneOf("add", "export", "history");
const Roles = defineState("roles", {
	schema: obj({ names: arr(Name), touched: int() }),
	version: 1,
	initial: () => ({ names: ["add", "export"] as Granted[], touched: 0 }),
});
const Access = local("bench.access", {
	version: 1,
	params: {},
	members: { roles: obj({ names: arr(Name), touched: int() }), grant: method(arr(Name)), touch: method(int()) },
});
const Thing = remote("bench.thing", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	state: { name: str(), history: grantable(arr(str())) },
	methods: { use: method(str(), str()), add: grantable(method(str(), str())) },
	flags: { export: "Export" },
});

let built = 0;
const facet = defineFacet<Principal>((h) => {
	h.serve(Access, (_, self) => {
		const state = self.state(Roles);
		return {
			roles: state,
			grant: async (names, ctx) => {
				await state.change((draft) => {
					draft.names = names;
				}, ctx);
				return null;
			},
			touch: async (touched, ctx) => {
				await state.change((draft) => {
					draft.touched = touched;
				}, ctx);
				return null;
			},
		};
	});
	h.serve(
		Thing,
		({ id }) => {
			built++;
			return {
				name: constant(id),
				history: () => constant(["h"]),
				use: async (text: string) => text,
				add: async (text: string) => text,
			};
		},
		// A new object of the same grant at every change of the source: what an admission over a store's row computes.
		{
			admit: (_p, _principal, self) =>
				self.derive([self.get(Access, {}).roles], ([r]) => allow({ granted: r.names })),
		},
	);
});

const server = createHost<Principal>({ address: Server(), principal: { kind: "server" }, onError: console.error });
await server.load([{ name: "@bench/hot-paths", facet }], context);
const client = createHost<Principal>({ onError: console.error });
await client.load([], context);
const [a, b] = memoryLinkPair();
server.accept(a, { principal: { kind: "person", id: "ada" } }, context);
client.connect(b, { principal: { kind: "server" } }, context);
const access = await server.get(Access, {}, context);

const inspector = new Session();
inspector.connect();
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const median = (list: number[]) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)]!;

/**
 * Runs `round` ROUNDS times for its median time per object after the warm-up, then SAMPLED times more under the
 * sampling heap profiler (which slows it several times over) for the bytes it allocates per object.
 */
async function measure(name: string, round: (index: number) => Promise<void>, list = false): Promise<void> {
	const times: number[] = [];
	for (let index = 0; index < ROUNDS; index++) {
		const start = performance.now();
		await round(index);
		times.push(performance.now() - start);
	}
	const sampling = { samplingInterval: 512, includeObjectsCollectedByMajorGC: true };
	await inspector.post("HeapProfiler.startSampling", { ...sampling, includeObjectsCollectedByMinorGC: true });
	for (let index = ROUNDS; index < ROUNDS + SAMPLED; index++) await round(index);
	const { profile } = await inspector.post("HeapProfiler.stopSampling");
	const byFunction = new Map<string, number>();
	let total = 0;
	const walk = (node: typeof profile.head): void => {
		const { functionName, url, lineNumber } = node.callFrame;
		const key = `${functionName || "(anonymous)"} ${url.replace(/.*packages\/chord\//, "")}:${lineNumber + 1}`;
		byFunction.set(key, (byFunction.get(key) ?? 0) + node.selfSize);
		total += node.selfSize;
		for (const child of node.children) walk(child);
	};
	walk(profile.head);
	const objects = SAMPLED * N;
	const each = (median(times.slice(WARM_UP)) * 1000) / N;
	console.log(`${name}: ${each.toFixed(1)} µs and ${(total / objects / 1024).toFixed(1)} KiB allocated per object`);
	if (!list) return;
	for (const [key, size] of [...byFunction].sort((x, y) => y[1] - x[1]).slice(0, 40)) {
		console.log(`${(size / objects).toFixed(0).padStart(7)} B  ${key}`);
	}
}

console.log(`${N} admitted objects over an in-memory link, ${ROUNDS} rounds (Node ${process.versions.node})`);
await measure("1. hold and release", async (index) => {
	const held = [];
	for (let id = 0; id < N; id++) held.push(await client.get(Thing, { id: `h${index}-${id}` }, context));
	for (const reference of held) reference.release();
	await turn();
});

const references = await Promise.all(
	Array.from({ length: N }, (_, id) => client.get(Thing, { id: `t${id}` }, context)),
);
const settled = async (names: number): Promise<void> => {
	while (!references.every((ref) => ref.granted.size === names && ref.state.value.kind === "live")) await turn();
};

let before = built;
await measure("2. re-read, the same decision", async (index) => {
	await access.touch(index + 1, context);
	await turn();
});
if (built !== before) throw new Error(`a re-read of the same decision rebuilt ${built - before} objects`);

before = built;
await measure(
	"3. rebuild, another grant",
	async (index) => {
		const names: Granted[] = index % 2 === 0 ? ["add"] : ["add", "export"];
		await access.grant(names, context);
		await settled(names.length);
	},
	LIST,
);
const expected = (ROUNDS + SAMPLED) * N;
if (built - before !== expected) throw new Error(`expected ${expected} rebuilds, counted ${built - before}`);
process.exit(0);
