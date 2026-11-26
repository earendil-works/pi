// Benchmark of what a held object keeps on its host (the hold-memory pass after slice 15): the heap one more object
// adds once it is live, for the shapes an app's objects are made of. On the server: a local object with its reference;
// with one derive; with a reference to a store; with one live query. Held over a link by a client in another process
// (so the server's heap is the server's alone): a remote object without an admission; with a constant admission
// granting members; with an admission that derives from one reference; for these the client's heap per held reference
// too (its references, remote objects and replicas). 1,000 objects per case after a warm-up of 1,000
// (code, its feedback and caches the first objects make are no object's; after 200 they still grew), the heap read
// after collections, on a SQLite `:memory:` store. Each case runs in a server process of its own: in one process,
// what an earlier case left to collect was freed during a later one and counted for it.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/hold-heap.ts
import { fork, spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, grantable, hostKind, local, method, obj, queries, remote, str } from "../../src/contracts/index.ts";
import { allow, createHost, defineFacet } from "../../src/host/index.ts";
import { ipcLink } from "../../src/link/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { constant } from "../../src/state/index.ts";
import { defineTable, eq, openStore, query, sqliteBackend } from "../../src/store/index.ts";

const OBJECTS = 1_000;
const WARM_UP = 1_000;

type Principal = { kind: "server" } | { kind: "person"; id: string };

const Server = hostKind("server");
const Rows = defineTable("rows", { version: 1, columns: { id: str(), team: str() }, key: ["id"] });
const Item = obj({ id: str(), team: str() });
const Store = local("bench.store", {
	version: 1,
	params: {},
	members: { rows: queries(Item, { one: obj({ id: str() }) }), seed: method(arr(Item)) },
});
const Roles = local("bench.roles", { version: 1, params: {}, members: { names: arr(str()) } });

const thing = {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	state: { name: str(), history: grantable(arr(str())) },
	methods: { use: method(str(), str()), add: grantable(method(str(), str())) },
	flags: { export: "Export" },
} as const;
const Bare = remote("bench.bare", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	state: { name: str() },
	methods: { use: method(str(), str()) },
});
const Granted = remote("bench.granted", thing);
const Admitted = remote("bench.admitted", thing);
const HELD = { Bare, Granted, Admitted } as const;

const Plain = local("bench.plain", { version: 1, params: { id: str() }, members: { v: str() } });
const Derived = local("bench.derived", { version: 1, params: { id: str() }, members: { v: str() } });
const Referring = local("bench.referring", { version: 1, params: { id: str() }, members: { v: str() } });
const Reading = local("bench.reading", {
	version: 1,
	params: { id: str() },
	members: { rows: obj({ rows: arr(Item), more: bool() }) },
});
const LOCAL = { Plain, Derived, Referring, Reading } as const;

const CASES = 7;

if (process.argv[2] === "client") await client();
else if (process.argv[2] === "case") await server(Number(process.argv[3]));
else {
	console.log(`Server heap per object, ${OBJECTS} objects (Node ${process.versions.node})`);
	for (let number = 1; number <= CASES; number++) {
		spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, "case", String(number)], {
			stdio: "inherit",
		});
	}
}

/** The heap once pending work ran and garbage was collected, repeatedly. */
async function heap(): Promise<number> {
	for (let round = 0; round < 8; round++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		globalThis.gc!();
	}
	return process.memoryUsage().heapUsed;
}

/** The client: holds `count` objects of a contract when told to, keeps them, and answers with its heap then. */
async function client(): Promise<void> {
	const host = createHost<Principal>({ onError: (error) => console.error(error) });
	host.connect(ipcLink(process as never), { principal: { kind: "server" } }, context);
	await host.load([], context);
	const kept: unknown[] = [];
	process.on("message", async (message) => {
		// The link's own messages share the channel (`ipcLink`): only the server's requests are handled here.
		if (typeof message !== "object" || message === null || message instanceof Uint8Array) return;
		const { hold, from, count } = message as { hold: keyof typeof HELD; from: number; count: number };
		for (let id = from; id < from + count; id++)
			kept.push(await host.get(HELD[hold], { id: `${hold}${id}` }, context));
		process.send!({ held: await heap() });
	});
	process.send!("connected");
}

/** The server: serves every type, forks the client, and prints the heap per object of case `number`. */
async function server(number: number): Promise<void> {
	const NAMES = ["add", "export"];
	const made = (id: string) => ({
		name: constant(id),
		history: () => constant(NAMES),
		use: async (text: string) => text,
		add: async (text: string) => text,
	});
	const facet = defineFacet<Principal>((h) => {
		h.serve(Store, (_params, self) => {
			const table = self.table(Rows);
			const one = ({ id }: { id: string }) => query(Rows).where((row) => eq(row.id, id));
			return {
				rows: self.queries(table, { map: (row) => row }, { one }),
				seed: async (rows, ctx) => {
					await self.tx(async (tx) => {
						for (const row of rows) tx.put(table, row);
					}, ctx);
					return null;
				},
			};
		});
		h.serve(Roles, () => ({ names: constant(NAMES) }));
		h.serve(Bare, ({ id }) => ({ name: constant(id), use: async (text) => text }));
		h.serve(Granted, ({ id }) => made(id), { admit: () => constant(allow({ granted: ["add", "export"] })) });
		h.serve(Admitted, ({ id }) => made(id), {
			admit: (_params, _principal, self) =>
				self.derive([self.get(Roles, {}).names], () => allow({ granted: ["add", "export"] })),
		});
		h.serve(Plain, ({ id }) => ({ v: constant(id) }));
		h.serve(Derived, ({ id }, self) => ({ v: self.derive([constant(id)], ([value]) => `${value}!`) }));
		h.serve(Referring, ({ id }, self) => {
			self.get(Store, {});
			return { v: constant(id) };
		});
		h.serve(Reading, (_params, self) => ({
			rows: self.liveQuery(self.get(Store, {}).rows.one, { id: "r1" }, { first: 10 }),
		}));
	});
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const host = createHost<Principal>({
		address: Server(),
		principal: { kind: "server" },
		store,
		onError: (error) => console.error(error),
	});
	await host.load([{ name: "@bench/hold-heap", facet }], context);
	const rows = Array.from({ length: 20 }, (_, index) => ({ id: `r${index}`, team: "t" }));
	await (await host.get(Store, {}, context)).seed(rows, context);

	const child = fork(process.argv[1]!, ["client"], { execArgv: process.execArgv, serialization: "advanced" });
	host.accept(ipcLink(child), { principal: { kind: "person", id: "ada" } }, context);
	const said = (what: string) => new Promise<void>((resolve) => child.on("message", (m) => m === what && resolve()));
	await said("connected");
	/** The client's heap after its last hold, when it held something. */
	let clientHeap: number | undefined;
	const kib = (bytes: number) => `${(bytes / OBJECTS / 1024).toFixed(2)} KiB`;

	/**
	 * The server heap one object of `make` adds (`make(from, count)` makes that many, numbered from `from`), and the
	 * client's for a held one.
	 */
	const perObject = async (make: (from: number, count: number) => Promise<void>): Promise<string> => {
		await make(0, WARM_UP);
		const before = await heap();
		const clientBefore = clientHeap;
		await make(WARM_UP, OBJECTS);
		const server = kib((await heap()) - before);
		return clientBefore === undefined ? server : `${server}, the client ${kib(clientHeap! - clientBefore)}`;
	};
	const references: unknown[] = [];
	const here = (name: keyof typeof LOCAL) => async (from: number, count: number) => {
		for (let id = from; id < from + count; id++) {
			references.push(await host.get(LOCAL[name] as typeof Plain, { id: `${name}${id}` }, context));
		}
	};
	const held = (hold: keyof typeof HELD) => async (from: number, count: number) => {
		child.send({ hold, from, count });
		clientHeap = await new Promise<number>((resolve) => {
			const answered = (message: unknown): void => {
				if (typeof message !== "object" || message === null || !("held" in message)) return;
				child.off("message", answered);
				resolve(message.held as number);
			};
			child.on("message", answered);
		});
	};

	const cases: readonly (readonly [string, (from: number, count: number) => Promise<void>])[] = [
		["a local object with a constant member, with its reference", here("Plain")],
		["the same with one derive", here("Derived")],
		["the same with a reference to a store", here("Referring")],
		["the same with one live query of that store", here("Reading")],
		["a remote object held over a link, no admission", held("Bare")],
		["the same, a constant admission granting two names", held("Granted")],
		["the same, its admission a derive over one reference", held("Admitted")],
	];
	const [title, make] = cases[number - 1]!;
	console.log(`${number}. ${title}: ${await perObject(make)}`);
	child.kill();
	await host.close(context);
	await store.close(context);
	process.exit(0);
}
