import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type AdmittedOf,
	arr,
	bytes,
	type EventMember,
	event,
	evolve,
	type GrantableName,
	grantable,
	hostKind,
	type Implementation,
	int,
	keyed,
	local,
	method,
	type NamedQuery,
	obj,
	queries,
	remote,
	str,
} from "../../src/contracts/index.ts";
import { contractData, currentMembers, currentVersion } from "../../src/contracts/internal.ts";
import type { Watchable } from "../../src/watch.ts";

const Note = obj({ text: str() });

const Server = hostKind("server");

const hostAddress = () => Server();

/** Declares through an untyped door, as a JavaScript caller would. */
const untyped = {
	remote: remote as (name: unknown, declaration: unknown) => unknown,
	local: local as (name: unknown, declaration: unknown) => unknown,
};

describe("declaration checks", () => {
	it("accept a remote and a local declaration", () => {
		const Notes = remote("notes", {
			version: 1,
			params: { session: str() },
			hostAddress,
			state: { notes: arr(Note) },
			methods: { add: grantable(method(Note, str())), clear: grantable(method()) },
			flags: { export: "Export the notes" },
		});
		expect(Notes).toMatchObject({ kind: "remote", name: "notes", version: 1 });
		expect(Notes.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		const Info = local("app.session-info", {
			version: 3,
			params: {},
			members: { init: obj({ title: str() }), clear: method() },
		});
		expect(Info).toMatchObject({ kind: "local", name: "app.session-info", version: 3 });
	});

	// Each case declares a valid `hostAddress` unless it checks that one, so the check it names is the one reached.
	it.each([
		["empty name", "", { version: 1, params: {}, hostAddress }, 'A contract name "": expected lowercase'],
		["name not a string", 1, { version: 1, params: {}, hostAddress }, "A contract name 1: expected lowercase"],
		["an uppercase name", "Notes", { version: 1, params: {}, hostAddress }, "expected lowercase"],
		["a name with a colon", "a:b", { version: 1, params: {}, hostAddress }, "expected lowercase"],
		["version zero", "n", { version: 0, params: {}, hostAddress }, "n.version: expected a positive integer"],
		["fractional version", "n", { version: 1.5, params: {}, hostAddress }, "n.version: expected a positive integer"],
		["unsafe version", "n", { version: 2 ** 53, params: {}, hostAddress }, "n.version: expected a positive integer"],
		["unknown declaration key", "n", { version: 1, params: {}, hostAddress, place: "x" }, 'n: unknown key "place"'],
		[
			"a host address that is no function",
			"n",
			{ version: 1, params: {}, hostAddress: "x" },
			"n.hostAddress: expected a function of the params",
		],
		["no host address", "n", { version: 1, params: {} }, "n.hostAddress: expected a function of the params"],
		["variants", "n", { version: 1, params: {}, hostAddress, variants: {} }, 'n: unknown key "variants"'],
		["missing params", "n", { version: 1, hostAddress }, "n.params: expected an object"],
		[
			"members, a local contract's key",
			"n",
			{ version: 1, params: {}, hostAddress, members: {} },
			'n: unknown key "members"',
		],
		[
			"a flag without a label",
			"n",
			{ version: 1, params: {}, hostAddress, flags: { export: 1 } },
			"n.flags.export: expected its label",
		],
		[
			"a schema under methods",
			"n",
			{ version: 1, params: {}, hostAddress, methods: { m: str() } },
			"n.methods.m: expected method(...)",
		],
		[
			"a method under state",
			"n",
			{ version: 1, params: {}, hostAddress, state: { s: method() } },
			"n.state.s: a method belongs in methods",
		],
		[
			"bad state schema",
			"n",
			{ version: 1, params: {}, hostAddress, state: { s: { not: {} } } },
			'n.state.s: unsupported keyword "not"',
		],
		[
			"open arguments",
			"n",
			{
				version: 1,
				params: {},
				hostAddress,
				methods: { m: method({ type: "object", properties: {} }) },
			},
			"n.methods.m.args: argument objects must be closed",
		],
		[
			"bad result",
			"n",
			{ version: 1, params: {}, hostAddress, methods: { m: method(undefined, { not: {} }) } },
			'n.methods.m.result: unsupported keyword "not"',
		],
	])("remote refuses %s", (_case, name, declaration, message) => {
		expect(() => untyped.remote(name, declaration)).toThrow(message);
	});

	it.each([
		["unknown key", { version: 1, params: {}, members: {}, variants: {} }, 'i: unknown key "variants"'],
		["a host address", { version: 1, params: {}, members: {}, hostAddress }, 'i: unknown key "hostAddress"'],
		[
			"bad member schema",
			{ version: 1, params: {}, members: { s: { not: {} } } },
			'i.members.s: unsupported keyword "not"',
		],
		[
			"open arguments",
			{ version: 1, params: {}, members: { m: method({ type: "object", properties: {} }) } },
			"i.members.m.args: argument objects must be closed",
		],
	])("local refuses %s", (_case, declaration, message) => {
		expect(() => untyped.local("i", declaration)).toThrow(message);
	});

	it("refuse a remote declaration without a host address at the type level", () => {
		expect(() =>
			// @ts-expect-error: every remote type declares its host address
			remote("n", { version: 1, params: {} }),
		).toThrow("n.hostAddress: expected a function of the params");
	});

	it("does not check state for closed objects", () => {
		expect(() =>
			local("i", {
				version: 1,
				params: {},
				members: { s: { type: "object", properties: { a: str() }, required: ["a"] } },
			}),
		).not.toThrow();
	});
});

describe("admission (slice 14 §2.1)", () => {
	const members = { state: { n: int() } };

	it("is typed by its schema with granted and never part of the fingerprint", () => {
		const Plain = remote("doc", { version: 1, params: {}, hostAddress, ...members });
		const Admitted = remote("doc", {
			version: 1,
			params: {},
			hostAddress,
			admission: obj({ mode: str() }),
			...members,
		});
		expect(Admitted.fingerprint).toBe(Plain.fingerprint);
		expectTypeOf<AdmittedOf<typeof Admitted>>().toEqualTypeOf<
			{ mode: string } & { readonly granted: ReadonlySet<never> }
		>();
		expectTypeOf<AdmittedOf<typeof Plain>>().toEqualTypeOf<never>();
		const other = remote("doc", { version: 1, params: {}, hostAddress, admission: obj({ mode: int() }), ...members });
		// Its own fingerprint, which a reload's staging compares.
		expect(contractData(Admitted).admission?.fingerprint).not.toBe(contractData(other).admission?.fingerprint);
		expect(contractData(Plain).admission).toBe(undefined);
	});

	it("is JSON, an object without granted, and belongs to remote contracts", () => {
		const declaration = { version: 1, params: {}, hostAddress, ...members };
		expect(() => untyped.remote("doc", { ...declaration, admission: obj({ data: bytes() }) })).toThrow(
			"doc.admission: an admission's value is JSON only (no bytes())",
		);
		expect(() => untyped.remote("doc", { ...declaration, admission: str() })).toThrow(
			"doc.admission: an admission's data is an obj(...)",
		);
		expect(() => untyped.remote("doc", { ...declaration, admission: obj({ granted: str() }) })).toThrow(
			'doc.admission: "granted" is Chord\'s',
		);
		expect(() => untyped.local("doc", { version: 1, params: {}, members: {}, admission: obj({}) })).toThrow(
			'doc: unknown key "admission"',
		);
	});

	it("is replaced by evolve's admission(schema), the last edit of a version; the wire fingerprint stays an edit's", () => {
		const V1 = remote("doc", { version: 1, params: {}, hostAddress, admission: obj({ mode: str() }), ...members });
		const V2 = evolve(V1, (e) => e.addState("m", int()));
		const V3 = evolve(V2, (e) => e.admission(obj({ mode: str(), since: int() })));
		expectTypeOf<AdmittedOf<typeof V2>>().toEqualTypeOf<
			{ mode: string } & { readonly granted: ReadonlySet<never> }
		>();
		expectTypeOf<AdmittedOf<typeof V3>>().toEqualTypeOf<
			{ mode: string; since: number } & { readonly granted: ReadonlySet<never> }
		>();
		// Carried over unchanged by an edit that is not its own.
		expect(contractData(V2).admission).toBe(contractData(V1).admission);
		expect(contractData(V3).admission?.fingerprint).not.toBe(contractData(V1).admission?.fingerprint);
		// A version whose only edit is its admission has the previous version's members.
		expect(V3.fingerprint).toBe(V2.fingerprint);
		const Gained = evolve(remote("doc", { version: 1, params: {}, hostAddress, ...members }), (e) =>
			e.admission(obj({ mode: str() })),
		);
		expectTypeOf<AdmittedOf<typeof Gained>>().toEqualTypeOf<
			{ mode: string } & { readonly granted: ReadonlySet<never> }
		>();
		expect(contractData(Gained).admission).not.toBe(undefined);
	});
});

describe("grantable members and flags (slice 15 §1.1)", () => {
	const Change = obj({ seq: int(), by: str() });
	const Canvas = remote("canvas.board", {
		version: 1,
		params: { canvas: str() },
		hostAddress,
		state: { shapes: arr(Note), history: grantable(arr(Change)) },
		events: { motion: obj({ x: int() }), reported: grantable(obj({ by: str() })) },
		methods: { point: method(int()), add: grantable(method(Note, str())), clear: grantable(method()) },
		flags: { export: "Export as image" },
	});

	it("record which members are grantable and the flags; the names an admission may grant, sorted", () => {
		const version = currentVersion(Canvas);
		expect([...version.grantable].sort()).toEqual(["add", "clear", "history", "reported"]);
		expect(version.grants).toEqual(["add", "clear", "export", "history", "reported"]);
		expect([...contractData(Canvas).flags]).toEqual([["export", "Export as image"]]);
		// A grantable member is a member like any other: its kind and schema as declared.
		expect([...currentMembers(Canvas).state.keys()]).toEqual(["shapes", "history"]);
	});

	it("type GrantableName as exactly the grantable members and flags, and the admitted value with granted", () => {
		expectTypeOf<GrantableName<typeof Canvas>>().toEqualTypeOf<"history" | "reported" | "add" | "clear" | "export">();
		expectTypeOf<AdmittedOf<typeof Canvas>>().toEqualTypeOf<
			unknown & { readonly granted: ReadonlySet<"history" | "reported" | "add" | "clear" | "export"> }
		>();
		type Factory = Implementation<typeof Canvas>;
		// Grantable state and events are builders; grantable methods are functions as any.
		expectTypeOf<Factory["history"]>().toEqualTypeOf<() => Watchable<{ seq: number; by: string }[]>>();
		expectTypeOf<Factory["reported"]>().toEqualTypeOf<() => EventMember<{ by: string }>>();
		expectTypeOf<Factory["shapes"]>().toEqualTypeOf<Watchable<{ text: string }[]>>();
	});

	it("put grantability and the flag names in the fingerprint, not the labels", () => {
		const declare = (history: unknown, flags: { readonly [flag: string]: string }) =>
			untyped.remote("canvas.board", {
				version: 1,
				params: {},
				hostAddress,
				state: { history },
				flags,
			}) as { readonly fingerprint: string };
		const plain = declare(arr(Change), {}).fingerprint;
		const granted = declare(grantable(arr(Change)), {}).fingerprint;
		const flagged = declare(arr(Change), { export: "Export" }).fingerprint;
		const relabelled = declare(arr(Change), { export: "Export as image" }).fingerprint;
		expect(new Set([plain, granted, flagged]).size).toBe(3);
		expect(relabelled).toBe(flagged);
	});

	it("refuse a name that is a member and a flag, at the type level and at declaration", () => {
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
				hostAddress,
				// @ts-expect-error: `add` is a flag
				methods: { add: method() },
				// @ts-expect-error: `add` is a member
				flags: { add: "Add" },
			}),
		).toThrow('n.flags.add: "add" is a member: a name is a member or a flag');
		expect(() => untyped.remote("n", { version: 1, params: {}, hostAddress, flags: { granted: "x" } })).toThrow(
			'n.flags.granted: "granted" is reserved',
		);
	});

	it("refuse grantable members in a local contract and in evolve's local editor", () => {
		expect(() => untyped.local("i", { version: 1, params: {}, members: { s: grantable(str()) } })).toThrow(
			"i.members.s: only a remote contract has grantable members",
		);
	});

	it("let evolve add grantable members and keep the others' grantability", () => {
		const V2 = evolve(Canvas, (e) =>
			e
				.addState("layers", grantable(arr(str())))
				.addMethod("lock", grantable(method(str())))
				.addEvent("cleared", grantable(obj({ by: str() })))
				.state("history", arr(obj({ seq: int(), by: str(), at: int() }))),
		);
		expect([...currentVersion(V2).grantable].sort()).toEqual([
			"add",
			"clear",
			"cleared",
			"history",
			"layers",
			"lock",
			"reported",
		]);
		expectTypeOf<GrantableName<typeof V2>>().toEqualTypeOf<
			"history" | "reported" | "add" | "clear" | "layers" | "lock" | "cleared" | "export"
		>();
		const V3 = evolve(V2, (e) => e.removeState("layers"));
		expect(currentVersion(V3).grantable.has("layers")).toBe(false);
	});
});

describe("D11: one kind per name", () => {
	it("refuses one name as state and a method", () => {
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
				hostAddress,
				// @ts-expect-error: `x` is both state and a method
				state: { x: str() },
				// @ts-expect-error: `x` is both a method and state
				methods: { x: method() },
			}),
		).toThrow('n.methods.x: "x" is declared twice');
	});
});

describe("reserved member names", () => {
	it.each(["then", "release", "granted", "state", "retry"])("refuses %s in remote, local and evolve", (name) => {
		expect(() => remote("n", { version: 1, params: {}, hostAddress, state: { [name]: str() } })).toThrow(
			`n.state.${name}: "${name}" is reserved: a reference has it`,
		);
		expect(() => local("n", { version: 1, params: {}, members: { [name]: method() } })).toThrow(
			`n.members.${name}: "${name}" is reserved: a reference has it`,
		);
		const base = local("n", { version: 1, params: {}, members: {} });
		expect(() => evolve(base, (e) => e.addState(name, str()))).toThrow(
			`n v2.members.${name}: "${name}" is reserved: a reference has it`,
		);
	});
});

describe("keyed members (slice 6a §12)", () => {
	it("declare a keyed member in a local contract: its own kind and a node of its own in the fingerprint", () => {
		const Keyed = local("app.store", { version: 1, params: {}, members: { notes: keyed(Note), add: method() } });
		const State = local("app.store", { version: 1, params: {}, members: { notes: Note, add: method() } });
		const members = currentMembers(Keyed);
		expect([[...members.keyed.keys()], [...members.state.keys()]]).toEqual([["notes"], []]);
		expect(Keyed.fingerprint).not.toBe(State.fingerprint);
		// Evolving the contract carries its keyed members over unchanged (their versions are slice 7's).
		const next = evolve(Keyed, (e) => e.addMethod("clear", str(), str()));
		expect(currentMembers(next).keyed.has("notes")).toBe(true);
	});

	it("refuse a keyed member in a remote contract, at the type level and at declaration", () => {
		expect(() =>
			remote("app.notes", {
				version: 1,
				params: {},
				hostAddress,
				// @ts-expect-error keyed members are only in local contracts
				state: { notes: keyed(Note) },
			}),
		).toThrow("app.notes.state.notes: keyed members are only in local contracts");
	});
});

describe("queries members (slice 14 §3.1)", () => {
	const args = { ofBoard: obj({ board: str() }), one: obj({ id: int() }) };
	const Store = local("app.store", { version: 1, params: {}, members: { notes: queries(Note, args), add: method() } });

	it("declare named queries in a local contract: their own kind, each query's argument schema in the fingerprint", () => {
		const members = currentMembers(Store);
		expect([...members.queries.get("notes")!.args.keys()]).toEqual(["ofBoard", "one"]);
		expect([...members.state.keys()]).toEqual([]);
		const other = { ...args, one: obj({ id: str() }) };
		const Changed = local("app.store", {
			version: 1,
			params: {},
			members: { notes: queries(Note, other), add: method() },
		});
		expect(Changed.fingerprint).not.toBe(Store.fingerprint);
		// A contract without one keeps its fingerprint: the pinned value in fingerprint.test.ts did not move.
		// Evolving the contract carries its queries members over unchanged (their edits are a later slice's).
		const next = evolve(Store, (e) => e.addMethod("clear", str(), str()));
		expect(currentMembers(next).queries.has("notes")).toBe(true);
		expect(() => evolve(Store, (e) => e.addState("notes", str()))).toThrow("already declared");
	});

	it("type the implementation as one named query per listed name", () => {
		type Notes = Implementation<typeof Store>["notes"];
		expectTypeOf<Notes["one"]>().toEqualTypeOf<NamedQuery<{ text: string }, { id: number }>>();
		expectTypeOf<Notes["ofBoard"]>().toEqualTypeOf<NamedQuery<{ text: string }, { board: string }>>();
	});

	it("refuse a queries member in a remote contract and argument schemas that are not closed", () => {
		expect(() =>
			untyped.remote("app.notes", {
				version: 1,
				params: {},
				hostAddress,
				state: { notes: queries(Note, {}) },
			}),
		).toThrow("app.notes.state.notes: queries members are only in local contracts");
		expect(() =>
			untyped.local("app.store", { version: 1, params: {}, members: { notes: queries(Note, { one: 5 as never }) } }),
		).toThrow("app.store.members.notes.args.one");
	});
});

describe("host-keyed keyed members", () => {
	const Session = hostKind("session", { id: str() });

	it("carry their host kind in the data and the fingerprint; string-keyed ones carry none", () => {
		const byAddress = local("store", {
			version: 1,
			params: {},
			members: { meta: keyed(obj({ n: int() }), Session) },
		});
		const byString = local("store", { version: 1, params: {}, members: { meta: keyed(obj({ n: int() })) } });
		const member = (contract: typeof byAddress | typeof byString) => currentMembers(contract).keyed.get("meta")!;
		expect(member(byAddress).key).toBe(Session);
		expect(member(byString).key).toBeUndefined();
		expect(byAddress.fingerprint).not.toBe(byString.fingerprint);
	});

	it("refuse a kind that was not declared", () => {
		expect(() =>
			local("store", { version: 1, params: {}, members: { meta: keyed(obj({}), { kind: "x" } as never) } }),
		).toThrow("x: not a declared host kind");
	});
});

describe('event members (decision "Events: fire-and-forget members")', () => {
	const Paddle = obj({ peer: str(), y: int() });

	it("declare events in a remote contract and with the local marker: their own kind, typed as event members", () => {
		const Match = remote("app.match", {
			version: 1,
			params: {},
			hostAddress,
			state: { score: int() },
			events: { paddle: Paddle },
		});
		const Store = local("app.store", { version: 1, params: {}, members: { score: int(), paddle: event(Paddle) } });
		expect([...currentMembers(Match).events.keys()]).toEqual(["paddle"]);
		const members = currentMembers(Store);
		expect([[...members.events.keys()], [...members.state.keys()]]).toEqual([["paddle"], ["score"]]);
		expectTypeOf<Implementation<typeof Store>["paddle"]>().toEqualTypeOf<EventMember<{ peer: string; y: number }>>();
	});

	it("keep one kind per name across the history", () => {
		expect(() =>
			untyped.remote("app.match", {
				version: 1,
				params: {},
				hostAddress,
				state: { paddle: Paddle },
				events: { paddle: Paddle },
			}),
		).toThrow('app.match.events.paddle: "paddle" is declared twice');
		const Store = local("app.store", { version: 1, params: {}, members: { paddle: event(Paddle) } });
		const without = evolve(Store, (e) => e.removeEvent("paddle"));
		expect(() => evolve(without, (e) => e.addState("paddle", Paddle))).toThrow(
			'"paddle" is an event member; its kind never changes',
		);
	});

	it("refuse bytes in events", () => {
		expect(() =>
			local("app.store", { version: 1, params: {}, members: { frame: event(obj({ data: bytes() })) } }),
		).toThrow("app.store.members.frame: an event's values are JSON only (no bytes())");
		expect(() =>
			untyped.remote("app.match", {
				version: 1,
				params: {},
				hostAddress,
				events: { x: method() },
			}),
		).toThrow("app.match.events.x: expected the schema of the event's values");
	});
});
