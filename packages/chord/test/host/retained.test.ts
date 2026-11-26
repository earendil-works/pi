// What a host retains after work came and went: a server host on a SQLite `:memory:` store and a client over an
// in-memory link stay open, their contracts and plugins alive, while rounds of objects, grants, holds over the link,
// live queries, counts and lists are made and released, with ids and grants that differ from round to round. After
// each round the heap returns to where it was after the warm-up, and what a round made is collected.

import { getHeapSpaceStatistics } from "node:v8";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	arr,
	bool,
	type Contract,
	grantable,
	int,
	local,
	method,
	obj,
	queries,
	remote,
	str,
} from "../../src/contracts/index.ts";
import { currentVersion, grantedMembers, memberOrder } from "../../src/contracts/internal.ts";
import { ChordError } from "../../src/data/index.ts";
import { Decision } from "../../src/host/admission.ts";
import { allow, createHost, defineFacet, type Host, type HostError, type Reference } from "../../src/host/index.ts";
import { List } from "../../src/host/list.ts";
import { ChordObject } from "../../src/host/object.ts";
import { Binding } from "../../src/host/reference.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { Hold } from "../../src/remote/hold.ts";
import { RemoteObject } from "../../src/remote/remote-object.ts";
import { constant } from "../../src/state/index.ts";
import { defineTable, eq, query } from "../../src/store/index.ts";
import type { ChordStore } from "../../src/store/store.ts";
import {
	assertGranted,
	expectCollected,
	flushed,
	instancesOf,
	memoryStore,
	rejection,
	Server,
	settledHeap,
	type TestPrincipal,
	transported,
} from "../support.ts";

/** What this file's GC checks follow, weakly: recorded from now on, cleared after each round (`forget`). */
const tracked = {
	objects: instancesOf(ChordObject, "attempt"),
	decisions: instancesOf(Decision, "declare"),
	bindings: instancesOf(Binding, "bind"),
	lists: instancesOf(List, "read"),
	holds: instancesOf(Hold, "start"),
	remotes: instancesOf(RemoteObject, "hold"),
};

const Rows = defineTable("ret.rows", {
	version: 1,
	columns: { id: int(), group: str(), touched: int() },
	key: ["id"],
	indexes: { by_group: ["group", "touched"] },
});
const Item = obj({ id: int(), touched: int() });

/** The store every round reads: rows by group, newest touched first. */
const Store = local("ret.store", {
	version: 1,
	params: {},
	members: {
		rows: queries(Item, { ofGroup: obj({ group: str() }) }),
		write: method(obj({ group: str(), from: int(), count: int() })),
		clear: method(str()),
	},
});

/** The names a round's admitted objects are granted; `set` changes them while they are held (a rebuild). */
const Roles = local("ret.roles", {
	version: 1,
	params: { round: int() },
	members: { names: arr(str()), set: method(arr(str())) },
});

const Plain = local("ret.plain", { version: 1, params: { id: str() }, members: { v: str() } });
const Derived = local("ret.derived", { version: 1, params: { id: str() }, members: { v: str() } });
const Referring = local("ret.referring", { version: 1, params: { id: str() }, members: { v: str() } });

/** A remote object without admission: a method with arguments and one that fails. */
const Bare = remote("ret.bare", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	state: { name: str() },
	methods: { use: method(str(), str()), fail: method() },
});

/** Eight grantable members (four state members, four methods) and two flags: 255 combinations of members. */
const wide = {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	state: {
		name: str(),
		s0: grantable(str()),
		s1: grantable(str()),
		s2: grantable(str()),
		s3: grantable(str()),
	},
	methods: {
		use: method(str(), str()),
		m0: grantable(method(str(), str())),
		m1: grantable(method(str(), str())),
		m2: grantable(method(str(), str())),
		m3: grantable(method(str(), str())),
	},
	flags: { f0: "Flag 0", f1: "Flag 1" },
} as const;
/** Granted one constant set of names. */
const Granted = remote("ret.granted", wide);
/** Granted `namesOf(n)` for the `n` in its id (`round-n`): each round another slice of the 255 combinations. */
const Combined = remote("ret.combined", wide);
/** Granted what its round's `Roles` lists (its id `round-i`): an admission deriving from a reference. */
const Admitted = remote("ret.admitted", wide);

type WideName = "s0" | "s1" | "s2" | "s3" | "m0" | "m1" | "m2" | "m3" | "f0" | "f1";
const MEMBERS: readonly WideName[] = ["s0", "s1", "s2", "s3", "m0", "m1", "m2", "m3"];

/** The members of combination `n` (1 to 255, one bit per member) and a flag or none, as `n` says. */
function namesOf(n: number): WideName[] {
	const names = MEMBERS.filter((_, index) => (n & (1 << index)) !== 0);
	return n % 3 === 0 ? names : [...names, n % 3 === 1 ? "f0" : "f1"];
}

/**
 * The combination round `k`'s `Roles` grants first, and the one it changes to while held: the same two in every
 * warm-up round, others in each later round.
 */
const rolesBefore = (k: number) => ((fresh(k) * 37) % 255) + 1;
const rolesAfter = (k: number) => ((fresh(k) * 37 + 128) % 255) + 1;

/** The combinations of `Combined` round `k` grants: the first slice in every warm-up round, another slice in each later one. */
function combinationsOf(k: number): number[] {
	const start = fresh(k) === 0 ? 0 : COMBINED + (fresh(k) - 1) * COMBINED;
	return Array.from({ length: COMBINED }, (_, c) => ((start + c) % 255) + 1);
}

/** 0 for a warm-up round (its grants are the warm-up's), then 1, 2, ... */
const fresh = (k: number) => Math.max(0, k - WARM_UP + 1);

/** A live query and a count of one group, held over the link. */
const Feed = remote("ret.feed", {
	version: 1,
	params: { group: str() },
	hostAddress: () => Server(),
	state: { rows: obj({ rows: arr(Item), more: bool() }), total: int() },
});

/** A screen's list of one group, held over the link. */
const Board = remote("ret.board", {
	version: 1,
	params: { view: str(), group: str() },
	hostAddress: () => Server(),
	state: { list: obj({ rows: arr(Item), moreAfter: bool() }) },
	methods: { more: method() },
});

/** The server's one plugin: every type above, served once for the whole test. */
const facet = defineFacet<TestPrincipal>((h) => {
	h.serve(Store, (_, self) => {
		const table = self.table(Rows);
		const rows = self.queries(
			table,
			{ map: ({ id, touched }) => ({ id, touched }), reads: ["id", "touched"] },
			{
				// by_group (group, touched): the newest touched first.
				ofGroup: ({ group }: { group: string }) =>
					query(Rows)
						.where((r) => eq(r.group, group))
						.orderBy((r) => r.touched, "desc"),
			},
		);
		return {
			rows,
			write: async ({ group, from, count }, ctx) => {
				await self.tx(async (tx) => {
					for (let id = from; id < from + count; id++) tx.put(table, { id, group, touched: id });
				}, ctx);
				return null;
			},
			clear: async (group, ctx) => {
				await self.tx(async (tx) => tx.deleteWhere(table, (r) => eq(r.group, group)), ctx);
				return null;
			},
		};
	});
	h.serve(Roles, ({ round }, self) => {
		const names = self.writable<string[]>(namesOf(rolesBefore(round)));
		return {
			names: self.derive([names], ([value]) => value),
			set: async (next) => {
				names.set(next);
				return null;
			},
		};
	});
	h.serve(Plain, ({ id }) => ({ v: constant(id) }));
	h.serve(Derived, ({ id }, self) => ({ v: self.derive([constant(id)], ([value]) => `${value}!`) }));
	h.serve(Referring, ({ id }, self) => {
		self.get(Store, {});
		return { v: constant(id) };
	});
	h.serve(Bare, ({ id }) => ({
		name: constant(id),
		use: async (text) => `${id} ${text}`,
		fail: async () => {
			throw new ChordError({ code: "forbidden", message: "refused" });
		},
	}));
	const wideOf = (id: string) => {
		const echo = async (text: string) => `${id} ${text}`;
		const shown = () => constant(id);
		return {
			name: constant(id),
			s0: shown,
			s1: shown,
			s2: shown,
			s3: shown,
			use: echo,
			m0: echo,
			m1: echo,
			m2: echo,
			m3: echo,
		};
	};
	h.serve(Granted, ({ id }) => wideOf(id), { admit: () => constant(allow({ granted: ["s0", "m0", "f0"] })) });
	h.serve(Combined, ({ id }) => wideOf(id), {
		admit: ({ id }) => constant(allow({ granted: namesOf(Number(id.split("-")[1])) })),
	});
	h.serve(Admitted, ({ id }) => wideOf(id), {
		admit: ({ id }, _principal, self) =>
			self.derive([self.get(Roles, { round: Number(id.split("-")[0]) }).names], ([names]) =>
				allow({ granted: names as WideName[] }),
			),
	});
	h.serve(Feed, ({ group }, _principal, self) => {
		const ofGroup = self.get(Store, {}).rows.ofGroup;
		return { rows: self.liveQuery(ofGroup, { group }, { first: 10 }), total: self.count(ofGroup, { group }) };
	});
	h.serve(Board, ({ group }, _principal, self) => {
		const list = self.list("rows", [[self.get(Store, {}).rows.ofGroup, { group }]], { first: 5 });
		return { list: list.value, more: (ctx) => list.more(ctx) };
	});
});

/**
 * How many objects of each shape a round makes (local, held over the link), and of `Combined`: with its roles, feed
 * and board 1,235 objects a round, so that 32 B kept per object would be ~230 KiB after the measured rounds.
 */
const LOCAL = 200;
const HELD = 200;
const COMBINED = 32;
const ROWS = 30;

/**
 * Rounds before the heap is taken as the base (compiled code and its feedback, tables that reach their size: the
 * heap still rises until about the 18th), all granting the same combinations; then rounds that each grant
 * combinations no earlier round granted: the warm-up's slice and 6 more of 32 stay below the 255.
 */
const WARM_UP = 20;
const MEASURED = 6;

/**
 * What the heap may grow by over the measured rounds. Measured on 1cbc0e094 (Node 26.11): a round holds 11.5-13 MiB
 * at its peak. When the measured rounds grant the warm-up's combinations too, the heap after them is 20-29 KiB above
 * the base (heap snapshots: compiled code's dependency lists, no JS object). With fresh grants it is 254-255 KiB
 * above it, ~42 KiB a round: `grantedMembers` keeps ~1 KiB per combination of granted members (the members and their
 * `memberOrder`), 34 new ones a round. The bound is above one round's leak and far below one round's work.
 */
const TOLERANCE = 128 * 1024;

type Hosts = {
	readonly store: ChordStore;
	readonly server: Host<TestPrincipal>;
	readonly client: Host<TestPrincipal>;
	readonly rows: Reference<typeof Store>;
	readonly errors: { readonly server: HostError[]; readonly client: HostError[] };
};

/** Weak references to what one round made. */
type RoundRefs = {
	/** The server's objects of the round (their attempts with them), decisions, served holds and lists. */
	readonly objects: WeakRef<object>[];
	/** Both hosts' references (bindings), the client's remote objects and their replicas. */
	readonly references: WeakRef<object>[];
	/** Every `granted` set of the round: the client's references' and the server's objects'. */
	readonly granted: WeakRef<object>[];
	/** The granted members (`grantedMembers`) of the round's combinations of `Combined` and `Admitted`, orders, maps. */
	readonly members: WeakRef<object>[];
};

describe("what a host retains after work came and went", () => {
	let hosts: Hosts;
	let next = 0;

	// The test runner formats a stack through its source maps, decoding and keeping a module's map the first time a
	// stack passes through it: hundreds of KiB of the runner's that appear in some round. V8's own text instead.
	const prepare = Error.prepareStackTrace;
	beforeAll(async () => {
		Error.prepareStackTrace = (error, frames) =>
			[String(error), ...frames.map((frame) => `    at ${frame}`)].join("\n");
		const store = await memoryStore();
		const errors = { server: [] as HostError[], client: [] as HostError[] };
		const server = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: (error) => errors.server.push(error),
		});
		await server.load([{ name: "@test/retained", facet }], context);
		const client = createHost<TestPrincipal>({ onError: (error) => errors.client.push(error) });
		await client.load([], context);
		const [up, down] = memoryLinkPair();
		server.accept(up, { principal: { kind: "owner" } }, context);
		client.connect(down, { principal: { kind: "server" } }, context);
		const rows = await server.get(Store, {}, context);
		hosts = { store, server, client, rows, errors };
	});

	afterAll(async () => {
		hosts.rows.release();
		await hosts.client.close(context);
		await hosts.server.close(context);
		await hosts.store.close(context);
		Error.prepareStackTrace = prepare;
	});

	// Found by this test (2026-11-26): `grantedMembers` kept one entry per combination of granted members ever seen
	// for its contract version's life (fixed: its table holds its members weakly).
	it("returns to the heap it had after the warm-up, round after round", async () => {
		const heaps: number[] = [];
		let peak = 0;
		const last = WARM_UP + MEASURED - 1;
		for (let index = 0; index <= last; index++) {
			// The heap while a round's work is all held, once: each reading collects garbage five times.
			const held = async () => {
				peak = await settledHeap();
			};
			await round(next++, hosts, index === last ? held : undefined);
			heaps.push(await dataHeap());
		}
		const base = heaps[WARM_UP - 1]!;
		const kib = (bytes: number) => Math.round(bytes / 1024);
		console.log(
			`heap after warm-up ${kib(base)} KiB; after each round, from it: ${heaps.map((heap) => kib(heap - base)).join(" ")} KiB; a round's work at its peak: ${kib(peak - base)} KiB`,
		);
		expect([hosts.errors.server, hosts.errors.client]).toEqual([[], []]);
		expect(heaps.at(-1)! - base).toBeLessThan(TOLERANCE);
	}, 60_000);

	it("collects a round's server objects (with their attempts), decisions, served holds and lists", async () => {
		const refs = await round(next++, hosts);
		await expectCollected(...refs.objects);
	});

	it("collects a round's references on both hosts, the client's remote objects and their replicas", async () => {
		const refs = await round(next++, hosts);
		await expectCollected(...refs.references);
	});

	it("collects a round's granted sets", async () => {
		const refs = await round(next++, hosts);
		await expectCollected(...refs.granted);
	});

	// Found by this test (2026-11-26), as above.
	it("collects the granted members of a round's grant combinations", async () => {
		const refs = await round(next++, hosts);
		await expectCollected(...refs.members);
	});
});

/**
 * Round `k`: makes every shape with ids and grants of its own, uses it, runs `held` while it is all held, and releases
 * it all until the server holds nothing of it; returns weak references to what it made.
 */
async function round(k: number, hosts: Hosts, held?: () => Promise<void>): Promise<RoundRefs> {
	const { server, client, rows } = hosts;
	const roles = await server.get(Roles, { round: k }, context);
	const locals: { release(): void }[] = [];
	for (let i = 0; i < LOCAL; i++) {
		const id = `${k}-${i}`;
		locals.push(await server.get(Plain, { id }, context));
		locals.push(await server.get(Derived, { id }, context));
		locals.push(await server.get(Referring, { id }, context));
	}
	const bare: Reference<typeof Bare>[] = [];
	const granted: Reference<typeof Granted>[] = [];
	const admitted: Reference<typeof Admitted>[] = [];
	for (let i = 0; i < HELD; i++) {
		const id = `${k}-${i}`;
		bare.push(await client.get(Bare, { id }, context));
		granted.push(await client.get(Granted, { id }, context));
		admitted.push(await client.get(Admitted, { id }, context));
	}
	const combinations = combinationsOf(k);
	const combined: Reference<typeof Combined>[] = [];
	for (const n of combinations) combined.push(await client.get(Combined, { id: `${k}-${n}` }, context));
	const group = `g${k}`;
	const feed = await client.get(Feed, { group }, context);
	const board = await client.get(Board, { view: `v${k}`, group }, context);

	// Rows inserted while the live query, the count and the list are open; the list paged once.
	await rows.write({ group, from: k * 1_000, count: ROWS }, context);
	await settles(() => feed.total.value === ROWS && board.list.value.rows.length === 5);
	await board.more(context);
	await settles(() => board.list.value.rows.length === 10 && feed.rows.value.rows.length === 10);

	// Calls: with arguments, one that fails, a granted method.
	expect(await bare[0]!.use("a", context)).toBe(`${k}-0 a`);
	expect(await rejection(bare[1]!.fail(context))).toMatchObject({ code: "forbidden" });
	const first = granted[0]!;
	assertGranted(first, ["m0"]);
	expect(await first.m0("b", context)).toBe(`${k}-0 b`);
	for (const ref of combined) if (ref.m1 !== undefined) await ref.m1("c", context);

	// A combination's members, their order lists and their maps (the keys of the member positions, `memberIndexes`).
	const members = (Type: Contract, n: number) => {
		const data = grantedMembers(currentVersion(Type), new Set(namesOf(n)));
		return [data, memberOrder(data), data.state, data.methods, data.events].map((value) => new WeakRef(value));
	};
	const memberRefs = [...combinations.flatMap((n) => members(Combined, n)), ...members(Admitted, rolesBefore(k))];

	// The grant changes while the admitted objects are held: each is rebuilt.
	const after = namesOf(rolesAfter(k));
	await roles.set(after, context);
	await settles(() => admitted.every((ref) => ref.granted.size === after.length && ref.state.value.kind === "live"));
	memberRefs.push(...members(Admitted, rolesAfter(k)));
	await held?.();

	// Rows deleted while the reads are open.
	await rows.clear(group, context);
	await settles(() => feed.total.value === 0 && board.list.value.rows.length === 0);

	const refs = roundRefs(memberRefs, [...bare, ...granted, ...admitted, ...combined]);
	for (const ref of [...locals, ...bare, ...granted, ...admitted, ...combined, feed, board, roles]) ref.release();
	// Local objects end at their last release (no linger); a hold over the link ends at the server once its release
	// arrived, which `host.activity` counts down.
	await settles(() => server.activity.value.references === 0);
	await transported();
	forget();
	return refs;
}

/** Weak references to what the round made, from what `tracked` recorded during it, and its references' grants. */
function roundRefs(members: WeakRef<object>[], held: readonly { readonly granted: ReadonlySet<string> }[]): RoundRefs {
	const derefs = <T extends object>(list: readonly WeakRef<T>[]) => [
		...new Set(list.map((ref) => ref.deref()).filter((value) => value !== undefined)),
	];
	// The store lives for the whole test: its object is no round's.
	const objects = derefs(tracked.objects).filter((object) => object.label !== "ret.store");
	const remotes = derefs(tracked.remotes);
	const weak = (values: readonly object[]) => values.map((value) => new WeakRef(value));
	return {
		objects: weak([...objects, ...derefs(tracked.decisions), ...derefs(tracked.holds), ...derefs(tracked.lists)]),
		references: weak([...derefs(tracked.bindings), ...remotes, ...remotes.flatMap(replicasOf)]),
		// Granted nothing is the one shared empty set, which lives with the module.
		granted: weak([...new Set([...held, ...objects].map((value) => value.granted))].filter((set) => set.size > 0)),
		members,
	};
}

/** The replicas of a remote object's plain state members (a grantable one is there only when granted). */
function replicasOf(object: RemoteObject): object[] {
	const { members, grantable } = currentVersion(object.contract);
	return [...members.state.keys()].filter((name) => !grantable.has(name)).map((name) => object.member(name));
}

/** `settledHeap()` without V8's code spaces: compiled code keeps growing over the rounds and is no host's memory. */
async function dataHeap(): Promise<number> {
	const heap = await settledHeap();
	const code = getHeapSpaceStatistics().filter(({ space_name }) => space_name.startsWith("code_"));
	return code.reduce((rest, space) => rest - space.space_used_size, heap);
}

/** Clears what `tracked` recorded: its weak references are no round's memory. */
function forget(): void {
	for (const list of Object.values(tracked)) list.length = 0;
}

/** Waits until `check` holds, a turn and a link hop at a time (rebuilds of many objects take many). */
async function settles(check: () => boolean): Promise<void> {
	for (let tries = 0; tries < 2_000 && !check(); tries++) await flushed();
	expect(check()).toBe(true);
}
