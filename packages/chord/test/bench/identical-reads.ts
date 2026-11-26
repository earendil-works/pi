// Identical live reads (decision "Identical live reads share one source"): N callers each holding their own object
// with an identical live read (the same named query, arguments and window), one write, the time until the last caller
// has it, and the heap per extra holder.
// - read: "live" (`self.liveQuery(..., { first })`) or "list" (`self.list(..., { first })`);
// - where: "local" (N objects on the server, watched there) or "remote" (N client hosts over memory links, each holding
//   its own object), or "shared" (N client hosts holding one object: one read, N wire holds);
// - load: "notes" (a notebook of 51 rows, a window of the newest 50; the write adds a row at the top) or "checklist"
//   (500 items, all in one window; the write ticks the last one).
// Per write: the time to the last delivery, the write's own time, and the server's counted work (query runs, probes,
// skips, derive computes, encodes, bytes sent). The heap is the process's, settled after collections: with `local` the
// server's alone, with `remote` and `shared` the client hosts', their links and replicas too (one process). Per extra
// holder: (H_N − H_1) / (N − 1), H_k the settled heap with k holders watching. Run by hand from packages/chord (not in
// CI):
//   node --conditions=source --expose-gc test/bench/identical-reads.ts <read> <where> <load> <n> [writes]
import { performance } from "node:perf_hooks";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, withTelemetry } from "../../src/context/index.ts";
import { arr, bool, hostKind, int, local, method, obj, queries, remote, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { type Link, memoryLinkPair } from "../../src/link/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { defineTable, eq, openStore, query, sqliteBackend } from "../../src/store/index.ts";

const [readKind = "list", where = "remote", load = "notes", nArg = "100", writesArg = "21"] = process.argv.slice(2);
const N = Number(nArg);
const WRITES = Number(writesArg);
const FIRST = load === "notes" ? 50 : 1000;

// ---- Counting telemetry (sums by name; its own startSpan so a host counts its background work) ----
const sums = new Map<string, number>();
const add = (name: string, value: number) => sums.set(name, (sums.get(name) ?? 0) + value);
const metrics = {
	counter: (name: string) => ({
		add: (value: number, attributes?: Record<string, unknown>) => {
			add(name, value);
			if (attributes?.direction !== undefined) add(`${name}.${String(attributes.direction)}`, value);
		},
	}),
	upDownCounter: (name: string) => ({ add: (value: number) => add(name, value) }),
	histogram: (name: string) => ({
		record: (value: number) => {
			add(`${name}.sum`, value);
			add(`${name}.count`, 1);
		},
	}),
};
const span = {
	metrics,
	startSpan: (_options: unknown, callback: (span: unknown) => unknown) =>
		new Promise((resolve) => resolve(callback(span))),
	addLink: () => {},
	addEvent: () => {},
	setAttributes: () => {},
	setStatus: () => {},
} as unknown as TelemetrySpan;
const context = withTelemetry(span, BACKGROUND_CONTEXT);

// ---- The model ----
type P = { kind: "owner" } | { kind: "server" };
const Server = hostKind("server");
const Notes = defineTable("notes", {
	version: 1,
	columns: { id: int(), book: str(), text: str(), at: int(), done: bool({ default: false }) },
	key: ["id"],
	indexes: { by_book: ["book", "at"] },
});
const Note = obj({ id: int(), text: str(), at: int(), done: bool() });
const Store = local("bench.notes-store", {
	version: 1,
	params: {},
	members: {
		notes: queries(Note, { newest: obj({ book: str() }), items: obj({ book: str() }) }),
		add: method(obj({ id: int(), text: str(), at: int() })),
		tick: method(obj({ id: int(), done: bool() })),
	},
});
const LiveReader = remote("bench.live-reader", {
	version: 1,
	params: { caller: str() },
	hostAddress: () => Server(),
	state: { items: obj({ rows: arr(Note), more: bool() }) },
});
const ListReader = remote("bench.list-reader", {
	version: 1,
	params: { caller: str() },
	hostAddress: () => Server(),
	state: { items: obj({ rows: arr(Note), moreAfter: bool() }) },
	methods: { more: method() },
});
const BOOK = "book-1";

const facet = defineFacet<P>((h) => {
	h.serve(Store, (_params, self) => {
		const table = self.table(Notes);
		return {
			notes: self.queries(
				table,
				{ map: (r) => ({ id: r.id, text: r.text, at: r.at, done: r.done }), reads: ["id", "text", "at", "done"] },
				{
					// by_book (book, at): the newest first, a notebook's list.
					newest: ({ book }: { book: string }) =>
						query(Notes)
							.where((n) => eq(n.book, book))
							.orderBy((n) => n.at, "desc"),
					// A checklist's items in their order (by_book: book, at ascending).
					items: ({ book }: { book: string }) =>
						query(Notes)
							.where((n) => eq(n.book, book))
							.orderBy((n) => n.at, "asc"),
				},
			),
			add: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(table, { ...row, book: BOOK, done: false }), ctx);
				return null;
			},
			tick: async ({ id, done }, ctx) => {
				await self.tx(async (tx) => tx.update(table, { id }, { done }), ctx);
				return null;
			},
		};
	});
	h.serve(LiveReader, (_params, _principal, self) => {
		const { notes } = self.get(Store, {});
		return { items: self.liveQuery(load === "notes" ? notes.newest : notes.items, { book: BOOK }, { first: FIRST }) };
	});
	h.serve(ListReader, (_params, _principal, self) => {
		const { notes } = self.get(Store, {});
		const list = self.list("items", [[load === "notes" ? notes.newest : notes.items, { book: BOOK }]], {
			first: FIRST,
		});
		return { items: list.value, more: (ctx) => list.more(ctx) };
	});
});

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

// ---- Run ----
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const server = createHost<P>({
	address: Server(),
	principal: { kind: "server" },
	store,
	telemetry: span,
	onError: (e) => console.error("server", e),
});
await server.load([{ name: "@bench/identical-reads", facet }], context);
const notes = await server.get(Store, {}, context);
const seed = load === "notes" ? 51 : 500;
for (let id = 1; id <= seed; id++) await notes.add({ id, text: `seed ${id}`, at: id }, context);

/** The heap after collections, in bytes. */
async function settledHeap(): Promise<number> {
	for (let round = 0; round < 4; round++) {
		globalThis.gc?.();
		await new Promise((resolve) => setImmediate(resolve));
	}
	return process.memoryUsage().heapUsed;
}

const Reader = (readKind === "live" ? LiveReader : ListReader) as typeof ListReader;
type Items = { rows: { id: number; text: string; at: number; done: boolean }[] };
type Watched = {
	items: {
		watch(
			c: unknown,
		): Promise<{ start(l: (call: { kind: string; value?: unknown }) => Promise<void>): void; stop(): Promise<void> }>;
	};
};
const sent = { bytes: 0 };
const clients: Host<P>[] = [];
const refs: Watched[] = [];
// Every caller watches its value as a client's hold does; `want` says what the next write must show.
let want: (items: Items) => boolean = () => true;
let pending = 0;
let seenAll: () => void = () => {};
const last: number[] = [];
const seen = new Array<boolean>(N).fill(true);

/** Caller `i` holds its object (or the shared one) and watches its value. */
async function holdAndWatch(i: number): Promise<void> {
	const caller = where === "shared" ? "shared" : `caller-${i}`;
	let ref: Watched;
	if (where === "local") ref = (await server.get(Reader, { caller }, context)) as never;
	else {
		const client = createHost<P>({ onError: (e) => console.error("client", e) });
		await client.load([], context);
		const [a, b] = memoryLinkPair();
		server.accept(counted(a, sent), { principal: { kind: "owner" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		clients.push(client);
		ref = (await client.get(Reader, { caller }, BACKGROUND_CONTEXT)) as never;
	}
	refs.push(ref);
	const watch = await ref.items.watch(BACKGROUND_CONTEXT);
	watch.start(async (call) => {
		if (call.kind !== "value" || seen[i] || !want(call.value as Items)) return;
		seen[i] = true;
		last[i] = performance.now();
		if (--pending === 0) seenAll();
	});
}

await holdAndWatch(0);
const heapOne = await settledHeap();
for (let i = 1; i < N; i++) await holdAndWatch(i);
const heapAll = await settledHeap();
const results: { total: number; write: number; counters: Record<string, number> }[] = [];
for (let w = 0; w < WRITES; w++) {
	const id = seed + 1 + w;
	const expected = `entry ${w}`;
	const done = w % 2 === 0;
	want = load === "notes" ? (items) => items.rows[0]?.text === expected : (items) => items.rows.at(-1)?.done === done;
	seen.fill(false);
	pending = N;
	const all = new Promise<void>((resolve) => {
		seenAll = resolve;
	});
	const before = new Map(sums);
	const started = performance.now();
	await (load === "notes"
		? notes.add({ id, text: expected, at: id }, context)
		: notes.tick({ id: seed, done }, context));
	const wrote = performance.now() - started;
	await all;
	const total = Math.max(...last) - started;
	const counters: Record<string, number> = {};
	for (const [k, v] of sums) if (v !== (before.get(k) ?? 0)) counters[k] = v - (before.get(k) ?? 0);
	results.push({ total, write: wrote, counters });
}
const cold = results.shift()!;
const sorted = [...results].sort((a, b) => a.total - b.total);
const med = (f: (r: (typeof results)[number]) => number) => {
	const xs = results.map(f).sort((a, b) => a - b);
	return xs[Math.floor(xs.length / 2)]!;
};
const c = (name: string) => med((r) => r.counters[name] ?? 0);
console.log(
	JSON.stringify({
		read: readKind,
		where,
		load,
		n: N,
		writes: results.length,
		coldMs: +cold.total.toFixed(2),
		medianMs: +med((r) => r.total).toFixed(2),
		minMs: +sorted[0]!.total.toFixed(2),
		maxMs: +sorted.at(-1)!.total.toFixed(2),
		writeMs: +med((r) => r.write).toFixed(2),
		heapBytes: heapAll,
		heapPerExtraHolderKB: N > 1 ? +((heapAll - heapOne) / (N - 1) / 1024).toFixed(1) : null,
		queryRuns: c("chord.query.runs"),
		probes: c("chord.query.probes"),
		skips: c("chord.query.skips"),
		rows: c("chord.query.rows"),
		derives: c("chord.derive.computes"),
		encodes: c("chord.link.encodes"),
		bytesSent: c("chord.link.bytes.sent"),
	}),
);
for (const client of clients) await client.close(BACKGROUND_CONTEXT);
await server.close(BACKGROUND_CONTEXT);
process.exit(0);
