import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type AdmittedOf,
	arr,
	bytes,
	type EventMember,
	event,
	evolve,
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
import { contractData, currentVariants, LOCAL } from "../../src/contracts/internal.ts";

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
			variants: {
				editor: { state: { notes: arr(Note) }, methods: { add: method(Note, str()), clear: method() } },
				reader: { state: { notes: arr(Note) } },
			},
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
		[
			"empty name",
			"",
			{ version: 1, params: {}, hostAddress, variants: { a: {} } },
			'A contract name "": expected lowercase',
		],
		[
			"name not a string",
			1,
			{ version: 1, params: {}, hostAddress, variants: { a: {} } },
			"A contract name 1: expected lowercase",
		],
		[
			"an uppercase name",
			"Notes",
			{ version: 1, params: {}, hostAddress, variants: { a: {} } },
			"expected lowercase",
		],
		[
			"a name with a colon",
			"a:b",
			{ version: 1, params: {}, hostAddress, variants: { a: {} } },
			"expected lowercase",
		],
		[
			"version zero",
			"n",
			{ version: 0, params: {}, hostAddress, variants: { a: {} } },
			"n.version: expected a positive integer",
		],
		[
			"fractional version",
			"n",
			{ version: 1.5, params: {}, hostAddress, variants: { a: {} } },
			"n.version: expected a positive integer",
		],
		[
			"unsafe version",
			"n",
			{ version: 2 ** 53, params: {}, hostAddress, variants: { a: {} } },
			"n.version: expected a positive integer",
		],
		[
			"unknown declaration key",
			"n",
			{ version: 1, params: {}, hostAddress, variants: { a: {} }, place: "x" },
			'n: unknown key "place"',
		],
		[
			"a host address that is no function",
			"n",
			{ version: 1, params: {}, variants: { a: {} }, hostAddress: "x" },
			"n.hostAddress: expected a function of the params",
		],
		[
			"no host address",
			"n",
			{ version: 1, params: {}, variants: { a: {} } },
			"n.hostAddress: expected a function of the params",
		],
		[
			"no variants",
			"n",
			{ version: 1, params: {}, hostAddress, variants: {} },
			"n.variants: at least one variant is required",
		],
		["missing params", "n", { version: 1, hostAddress, variants: { a: {} } }, "n.params: expected an object"],
		[
			"unknown variant key",
			"n",
			{ version: 1, params: {}, hostAddress, variants: { a: { members: {} } } },
			'n.a: unknown key "members"',
		],
		[
			"a schema under methods",
			"n",
			{ version: 1, params: {}, hostAddress, variants: { a: { methods: { m: str() } } } },
			"n.a.methods.m: expected method(...)",
		],
		[
			"a method under state",
			"n",
			{ version: 1, params: {}, hostAddress, variants: { a: { state: { s: method() } } } },
			"n.a.state.s: a method belongs in methods",
		],
		[
			"bad state schema",
			"n",
			{ version: 1, params: {}, hostAddress, variants: { a: { state: { s: { not: {} } } } } },
			'n.a.state.s: unsupported keyword "not"',
		],
		[
			"open arguments",
			"n",
			{
				version: 1,
				params: {},
				hostAddress,
				variants: { a: { methods: { m: method({ type: "object", properties: {} }) } } },
			},
			"n.a.methods.m.args: argument objects must be closed",
		],
		[
			"bad result",
			"n",
			{ version: 1, params: {}, hostAddress, variants: { a: { methods: { m: method(undefined, { not: {} }) } } } },
			'n.a.methods.m.result: unsupported keyword "not"',
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
			remote("n", { version: 1, params: {}, variants: { a: {} } }),
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
	const variants = { a: { state: { n: int() } } };

	it("is typed by its schema and never part of the fingerprint", () => {
		const Plain = remote("doc", { version: 1, params: {}, hostAddress, variants });
		const Admitted = remote("doc", {
			version: 1,
			params: {},
			hostAddress,
			admission: obj({ mode: str() }),
			variants,
		});
		expect(Admitted.fingerprint).toBe(Plain.fingerprint);
		expectTypeOf<AdmittedOf<typeof Admitted>>().toEqualTypeOf<{ mode: string }>();
		expectTypeOf<AdmittedOf<typeof Plain>>().toEqualTypeOf<never>();
		const other = remote("doc", { version: 1, params: {}, hostAddress, admission: obj({ mode: int() }), variants });
		// Its own fingerprint, which a reload's staging compares.
		expect(contractData(Admitted).admission?.fingerprint).not.toBe(contractData(other).admission?.fingerprint);
		expect(contractData(Plain).admission).toBe(undefined);
	});

	it("is JSON only, and belongs to remote contracts", () => {
		const declaration = { version: 1, params: {}, hostAddress, variants };
		expect(() => untyped.remote("doc", { ...declaration, admission: obj({ data: bytes() }) })).toThrow(
			"doc.admission: an admission's value is JSON only (no bytes())",
		);
		expect(() => untyped.local("doc", { version: 1, params: {}, members: {}, admission: obj({}) })).toThrow(
			'doc: unknown key "admission"',
		);
	});

	it("is replaced by evolve's admission(schema), the last edit of a version; the wire fingerprint stays an edit's", () => {
		const V1 = remote("doc", { version: 1, params: {}, hostAddress, admission: obj({ mode: str() }), variants });
		const V2 = evolve(V1, (e) => e.addState("a", "m", int()));
		const V3 = evolve(V2, (e) => e.admission(obj({ mode: str(), since: int() })));
		expectTypeOf<AdmittedOf<typeof V2>>().toEqualTypeOf<{ mode: string }>();
		expectTypeOf<AdmittedOf<typeof V3>>().toEqualTypeOf<{ mode: string; since: number }>();
		// Carried over unchanged by an edit that is not its own.
		expect(contractData(V2).admission).toBe(contractData(V1).admission);
		expect(contractData(V3).admission?.fingerprint).not.toBe(contractData(V1).admission?.fingerprint);
		// A version whose only edit is its admission has the previous version's members.
		expect(V3.fingerprint).toBe(V2.fingerprint);
		const Gained = evolve(remote("doc", { version: 1, params: {}, hostAddress, variants }), (e) =>
			e.admission(obj({ mode: str() })),
		);
		expectTypeOf<AdmittedOf<typeof Gained>>().toEqualTypeOf<{ mode: string }>();
		expect(contractData(Gained).admission).not.toBe(undefined);
	});
});

describe("D11: members across variants", () => {
	it("refuses a name that is state in one variant and a method in another", () => {
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
				hostAddress,
				// @ts-expect-error: `x` is a method in variant b
				variants: { a: { state: { x: str() } }, b: { methods: { x: method() } } },
			}),
		).toThrow('n.b.methods.x: "x" is a state member; its kind never changes');
	});

	it("refuses one name as state and method within a variant", () => {
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
				hostAddress,
				// @ts-expect-error: `x` is both state and a method
				variants: { a: { state: { x: str() }, methods: { x: method() } } },
			}),
		).toThrow('n.a.methods.x: "x" is a state member');
	});

	it("refuses a method with different signatures in two variants", () => {
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
				hostAddress,
				// @ts-expect-error: `m` takes a string in a and an integer in b
				variants: { a: { methods: { m: method(str()) } }, b: { methods: { m: method(int()) } } },
			}),
		).toThrow("n.b.methods.m: a method has the same signature in every variant");
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
				hostAddress,
				variants: {
					a: { methods: { m: method(str(), str()) } },
					b: { methods: { m: method(str({ max: 3 }), str()) } },
				},
			}),
		).toThrow("n.b.methods.m: a method has the same signature in every variant");
	});

	it("allows state schemas to differ per variant (redaction)", () => {
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
				hostAddress,
				variants: {
					editor: { state: { notes: arr(obj({ text: str(), author: str() })) }, methods: { m: method(str()) } },
					reader: { state: { notes: arr(obj({ text: str() })) }, methods: { m: method(str()) } },
				},
			}),
		).not.toThrow();
	});
});

describe("reserved member names", () => {
	it.each(["then", "release", "variant", "state", "retry"])("refuses %s in remote, local and evolve", (name) => {
		expect(() =>
			remote("n", { version: 1, params: {}, hostAddress, variants: { v: { state: { [name]: str() } } } }),
		).toThrow(`n.v.state.${name}: "${name}" is reserved: a reference has it`);
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
		const variant = currentVariants(Keyed).get(LOCAL)!;
		expect([[...variant.keyed.keys()], [...variant.state.keys()]]).toEqual([["notes"], []]);
		expect(Keyed.fingerprint).not.toBe(State.fingerprint);
		// Evolving the contract carries its keyed members over unchanged (their versions are slice 7's).
		const next = evolve(Keyed, (e) => e.addMethod("clear", str(), str()));
		expect(currentVariants(next).get(LOCAL)!.keyed.has("notes")).toBe(true);
	});

	it("refuse a keyed member in a remote contract, at the type level and at declaration", () => {
		expect(() =>
			remote("app.notes", {
				version: 1,
				params: {},
				hostAddress,
				// @ts-expect-error keyed members are only in local contracts
				variants: { editor: { state: { notes: keyed(Note) } } },
			}),
		).toThrow("app.notes.editor.state.notes: keyed members are only in local contracts");
	});
});

describe("queries members (slice 14 §3.1)", () => {
	const args = { ofBoard: obj({ board: str() }), one: obj({ id: int() }) };
	const Store = local("app.store", { version: 1, params: {}, members: { notes: queries(Note, args), add: method() } });

	it("declare named queries in a local contract: their own kind, each query's argument schema in the fingerprint", () => {
		const variant = currentVariants(Store).get(LOCAL)!;
		expect([...variant.queries.get("notes")!.args.keys()]).toEqual(["ofBoard", "one"]);
		expect([...variant.state.keys()]).toEqual([]);
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
		expect(currentVariants(next).get(LOCAL)!.queries.has("notes")).toBe(true);
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
				variants: { editor: { state: { notes: queries(Note, {}) } } },
			}),
		).toThrow("app.notes.editor.state.notes: queries members are only in local contracts");
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
		const member = (contract: typeof byAddress | typeof byString) =>
			currentVariants(contract).get(LOCAL)!.keyed.get("meta")!;
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

	it("declare events in a remote variant and with the local marker: their own kind, typed as event members", () => {
		const Match = remote("app.match", {
			version: 1,
			params: {},
			hostAddress,
			variants: { player: { state: { score: int() }, events: { paddle: Paddle } }, watcher: { events: {} } },
		});
		const Store = local("app.store", { version: 1, params: {}, members: { score: int(), paddle: event(Paddle) } });
		expect([...currentVariants(Match).get("player")!.events.keys()]).toEqual(["paddle"]);
		const variant = currentVariants(Store).get(LOCAL)!;
		expect([[...variant.events.keys()], [...variant.state.keys()]]).toEqual([["paddle"], ["score"]]);
		expectTypeOf<Implementation<typeof Store>["paddle"]>().toEqualTypeOf<EventMember<{ peer: string; y: number }>>();
	});

	it("keep one kind per name across variants and the history", () => {
		expect(() =>
			untyped.remote("app.match", {
				version: 1,
				params: {},
				hostAddress,
				variants: { a: { state: { paddle: Paddle } }, b: { events: { paddle: Paddle } } },
			}),
		).toThrow('app.match.b.events.paddle: "paddle" is a state member; its kind never changes');
		const Store = local("app.store", { version: 1, params: {}, members: { paddle: event(Paddle) } });
		const without = evolve(Store, (e) => e.removeEvent("paddle"));
		expect(() => evolve(without, (e) => e.addState("paddle", Paddle))).toThrow(
			'"paddle" is an event member; its kind never changes',
		);
	});

	it("allow an event's schema to differ per variant (redaction), and refuse bytes", () => {
		expect(() =>
			remote("app.match", {
				version: 1,
				params: {},
				hostAddress,
				variants: { a: { events: { paddle: Paddle } }, b: { events: { paddle: obj({ y: int() }) } } },
			}),
		).not.toThrow();
		expect(() =>
			local("app.store", { version: 1, params: {}, members: { frame: event(obj({ data: bytes() })) } }),
		).toThrow("app.store.members.frame: an event's values are JSON only (no bytes())");
		expect(() =>
			untyped.remote("app.match", {
				version: 1,
				params: {},
				hostAddress,
				variants: { a: { events: { x: method() } } },
			}),
		).toThrow("app.match.a.events.x: expected the schema of the event's values");
	});
});
