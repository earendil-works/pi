import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "../../src/context/index.ts";
import { contractData } from "../../src/contracts/contract.ts";
import {
	arr,
	bytes,
	event,
	evolve,
	grantable,
	type Implementation,
	int,
	keyed,
	local,
	memberNames,
	method,
	nul,
	obj,
	type ParamsOf,
	queries,
	remote,
	str,
	union,
} from "../../src/contracts/index.ts";
import {
	checkAccepts,
	currentMembers,
	currentVersion,
	grantedMembers,
	grantIndexes,
	memberOrder,
	takesNoArgs,
} from "../../src/contracts/internal.ts";
import { bindProvider, checkParams } from "../../src/data/internal.ts";
import { allow, createHost, defineFacet } from "../../src/host/index.ts";
import { binaryCodec, type Codec, memoryLinkPair } from "../../src/link/index.ts";
import { constant, type Watchable } from "../../src/state/index.ts";
import { expectCollected, flagLabel, Server, type TestPrincipal } from "../support.ts";

const Notes = remote("notes", {
	version: 1,
	params: { session: str(), page: int() },
	hostAddress: () => Server(),
	state: { notes: arr(str()) },
	methods: { add: grantable(method(obj({ text: str() }), str())), clear: grantable(method()) },
});

describe("contract handles", () => {
	it("carry kind, name, version and fingerprint only", () => {
		expect(Object.keys(Notes)).toEqual(["kind", "name", "version", "fingerprint"]);
	});

	it("are branded: spread and hand-built copies are refused", () => {
		const copy = { ...Notes };
		const refusal = "notes: not a declared contract (spread and hand-built copies are refused)";
		expect(() => contractData(copy)).toThrow(refusal);
		expect(() => evolve(copy, (e) => e)).toThrow(refusal);
		expect(() => checkAccepts(copy, {})).toThrow(refusal);
		expect(() => bindProvider(copy, {})).toThrow(refusal);
		expect(() => checkParams(copy, { session: "s", page: 1 }, BACKGROUND_CONTEXT)).toThrow(refusal);
	});

	it("are collected when dropped, with their data", async () => {
		const refs = (() => {
			const contract = local("gc", { version: 1, params: {}, members: { s: str() } });
			return [new WeakRef(contract), new WeakRef(contractData(contract))];
		})();
		await expectCollected(...refs);
	});
});

describe("member names", () => {
	it("lists a remote contract's state members, methods and event members of the current version, grantable ones too", () => {
		expect(memberNames(Notes)).toEqual({ state: ["notes"], methods: ["add", "clear"], events: [] });
		const next = evolve(Notes, (e) => e.addState("count", int()).removeMethod("clear"));
		expect(memberNames(next)).toEqual({ state: ["notes", "count"], methods: ["add"], events: [] });
	});

	it("lists a local contract's, without its keyed and queries members", () => {
		const Store = local("names.store", {
			version: 1,
			params: {},
			members: {
				count: int(),
				notes: keyed(str()),
				rows: queries(obj({ id: str() }), { one: obj({ id: str() }) }),
				ticked: event(int()),
				add: method(int()),
			},
		});
		expect(memberNames(Store)).toEqual({ state: ["count"], methods: ["add"], events: ["ticked"] });
	});

	it("refuses a copy of a contract", () => {
		expect(() => memberNames({ ...Notes })).toThrow("not a declared contract");
	});
});

describe("granted members and indexes", () => {
	it("are the same for an equal set of other objects: the same members, the same indexes in the grants' order", () => {
		const version = currentVersion(Notes);
		const granted = new Set(["clear", "add"]);
		const members = grantedMembers(version, granted);
		expect([...members.methods.keys()]).toEqual(["add", "clear"]);
		expect(grantedMembers(version, granted)).toBe(members);
		expect(grantedMembers(version, new Set(["add", "clear"]))).toBe(members);
		expect([...grantedMembers(version, new Set(["clear"])).methods.keys()]).toEqual(["clear"]);
		const indexes = grantIndexes(version, granted);
		expect(indexes).toEqual([0, 1]);
		// A list of the caller's own each time: a message's codec may write it.
		const again = grantIndexes(version, granted);
		expect([again, again === indexes]).toEqual([[0, 1], false]);
		expect(grantIndexes(version, new Set(["clear", "add"]))).toEqual([0, 1]);
		expect(grantIndexes(version, new Set(["clear", "other"]))).toEqual([1]);
	});

	it("keep no granted set, and are collected with their contract", async () => {
		const held: { contract?: object } = {};
		const { sets, kept } = (() => {
			const contract = remote("gc.granted", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				state: { n: int() },
				methods: { go: grantable(method()) },
			});
			held.contract = contract;
			const version = currentVersion(contract);
			const granted = new Set(["go"]);
			const members = grantedMembers(version, granted);
			grantIndexes(version, granted);
			// Another set of the same names shares the members; neither set is kept by the caches.
			const other = new Set(["go"]);
			expect(grantedMembers(version, other)).toBe(members);
			grantIndexes(version, other);
			return {
				sets: [new WeakRef(granted), new WeakRef(other)],
				kept: [new WeakRef(contract), new WeakRef(members)],
			};
		})();
		await expectCollected(...sets);
		held.contract = undefined;
		await expectCollected(...kept);
	});
});

describe("member order", () => {
	it("is made once per members: every binding of them shares the lists, each kind sorted", () => {
		const members = currentMembers(Notes);
		const order = memberOrder(members);
		expect(order).toEqual({ state: ["notes"], methods: ["add", "clear"], events: [] });
		expect(memberOrder(members)).toBe(order);
		// Granted members are members of their own: their order is theirs, made once too.
		const granted = grantedMembers(currentVersion(Notes), new Set(["add"]));
		expect(memberOrder(granted)).toEqual({ state: ["notes"], methods: ["add"], events: [] });
		expect(memberOrder(grantedMembers(currentVersion(Notes), new Set(["add"])))).toBe(memberOrder(granted));
	});

	it("is kept by no contract: both are collected", async () => {
		const refs = (() => {
			const contract = local("gc.order", { version: 1, params: {}, members: { s: str(), go: method() } });
			return [new WeakRef(contract), new WeakRef(memberOrder(currentMembers(contract)))];
		})();
		await expectCollected(...refs);
	});
});

describe("derived types", () => {
	it("Implementation: every member, state watchables and methods taking args and a context", () => {
		type Members = Implementation<typeof Notes>;
		expectTypeOf<keyof Members>().toEqualTypeOf<"notes" | "add" | "clear">();
		expectTypeOf<Members["notes"]>().toEqualTypeOf<Watchable<string[]>>();
		expectTypeOf<Members["add"]>().toEqualTypeOf<(args: { text: string }, context: Context) => Promise<string>>();
		// A method without arguments omits them.
		expectTypeOf<Members["clear"]>().toEqualTypeOf<(context: Context) => Promise<null>>();
	});

	it("Implementation of a local contract is flat", () => {
		const Info = local("info", {
			version: 1,
			params: {},
			members: { title: str(), blob: bytes(), save: method(str()) },
		});
		type Info = Implementation<typeof Info>;
		expectTypeOf<keyof Info>().toEqualTypeOf<"title" | "blob" | "save">();
		expectTypeOf<Info["save"]>().toEqualTypeOf<(args: string, context: Context) => Promise<null>>();
		const Counts = local("counts", {
			version: 1,
			params: {},
			members: { reset: method(), total: method(undefined, int()), maybe: method(union([nul(), str()])) },
		});
		type Counts = Implementation<typeof Counts>;
		expectTypeOf<Counts["reset"]>().toEqualTypeOf<(context: Context) => Promise<null>>();
		expectTypeOf<Counts["total"]>().toEqualTypeOf<(context: Context) => Promise<number>>();
		// Only a `null` argument schema is omitted; a union with null is an argument.
		expectTypeOf<Counts["maybe"]>().toEqualTypeOf<(args: string | null, context: Context) => Promise<null>>();
	});

	it("takesNoArgs: exactly the methods whose argument schema is null", () => {
		const Counts = local("counts", {
			version: 1,
			params: {},
			members: {
				reset: method(),
				total: method(undefined, int()),
				set: method(int()),
				maybe: method(union([nul(), str()])),
			},
		});
		const methods = [...currentMembers(Counts).methods].map(([name, data]) => [name, takesNoArgs(data)]);
		expect(methods).toEqual([
			["reset", true],
			["total", true],
			["set", false],
			["maybe", false],
		]);
	});

	it("ParamsOf: the params object", () => {
		expectTypeOf<ParamsOf<typeof Notes>>().toEqualTypeOf<{ readonly session: string; readonly page: number }>();
	});
});

// Found by the review of the hot-path pass (2026-11-26): grantIndexes handed every bind of a set one shared list.
// The owner's rule for caches (2026-11-26): a clear eviction rule, no ever-growing host memory.
describe("granted members of combinations nothing grants any more", () => {
	it("are collected with their order and their entry while the version lives; granted again, they work", async () => {
		const Many = remote("gc.many-grants", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			state: { n: int() },
			methods: { a: grantable(method()), b: grantable(method()), c: grantable(method()), d: grantable(method()) },
		});
		const version = currentVersion(Many);
		const names = ["a", "b", "c", "d"];
		const tables = new Set<Map<unknown, unknown>>();
		const pending: (() => void)[] = [];
		// V8 need not schedule finalizers, even after a forced GC. Deliver the registered holdings explicitly.
		class TestRegistry<T> {
			readonly clean: (holding: T) => void;
			constructor(clean: (holding: T) => void) {
				this.clean = clean;
			}
			register(target: object, holding: T) {
				const ref = new WeakRef(target);
				pending.push(() => {
					expect(ref.deref()).toBeUndefined();
					this.clean(holding);
				});
			}
		}
		const set = Map.prototype.set;
		// Keep the table observable without retaining the members behind its weak references.
		Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
			if (typeof key === "string" && key.startsWith("[") && value instanceof WeakRef) tables.add(this);
			return set.call(this, key, value);
		};
		let made: WeakRef<object>[];
		try {
			vi.stubGlobal("FinalizationRegistry", TestRegistry);
			made = (() => {
				const refs: WeakRef<object>[] = [];
				for (let mask = 1; mask < 16; mask++) {
					const granted = new Set(names.filter((_, index) => (mask & (1 << index)) !== 0));
					const members = grantedMembers(version, granted);
					refs.push(new WeakRef(members), new WeakRef(memberOrder(members)));
				}
				return refs;
			})();
		} finally {
			Map.prototype.set = set;
			vi.unstubAllGlobals();
		}
		expect(tables.size).toBe(1);
		const [table] = tables;
		expect(table.size).toBe(15);
		await expectCollected(...made);
		expect(pending).toHaveLength(15);
		for (const clean of pending) clean();
		expect(table.size).toBe(0);
		const again = grantedMembers(version, new Set(["b", "d"]));
		expect([[...again.methods.keys()], memberOrder(again).methods]).toEqual([
			["b", "d"],
			["b", "d"],
		]);
		expect(grantedMembers(version, new Set(["d", "b"]))).toBe(again);
	});
});

describe("granted indexes in bound messages", () => {
	it("a codec that clears the lists it sent does not change what later binds grant", async () => {
		const Thing = remote("codec.granted", {
			version: 1,
			params: { n: int() },
			hostAddress: () => Server(),
			state: { name: str() },
			flags: { export: flagLabel("export") },
		});
		const lists: unknown[] = [];
		const clearing: Codec = {
			name: binaryCodec.name,
			encode(message) {
				const bytes = binaryCodec.encode(message);
				if (message.kind === "bound") {
					for (const entry of message.holds) {
						lists.push(entry.granted);
						(entry.granted as number[]).length = 0;
					}
				}
				return bytes;
			},
			decode: (bytes) => binaryCodec.decode(bytes),
		};
		const server = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await server.load(
			[
				{
					name: "@test/codec",
					facet: defineFacet<TestPrincipal>((host) =>
						host.serve(Thing, () => ({ name: constant("n") }), {
							admit: () => constant(allow({ granted: ["export"] })),
						}),
					),
				},
			],
			BACKGROUND_CONTEXT,
		);
		const client = createHost<TestPrincipal>({ onError: () => {} });
		await client.load([], BACKGROUND_CONTEXT);
		const links = memoryLinkPair();
		server.accept(links[0], { principal: { kind: "owner" }, codec: clearing }, BACKGROUND_CONTEXT);
		client.connect(links[1], { principal: { kind: "server" }, codec: binaryCodec }, BACKGROUND_CONTEXT);
		const first = await client.get(Thing, { n: 1 }, BACKGROUND_CONTEXT);
		const second = await client.get(Thing, { n: 2 }, BACKGROUND_CONTEXT);
		expect([...first.granted]).toEqual(["export"]);
		expect([...second.granted]).toEqual(["export"]);
		expect(lists.length).toBeGreaterThanOrEqual(2);
		expect(lists[0]).not.toBe(lists[1]);
		await client.close(BACKGROUND_CONTEXT);
		await server.close(BACKGROUND_CONTEXT);
	});
});
