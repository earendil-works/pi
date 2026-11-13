import { describe, expect, expectTypeOf, it } from "vitest";
import {
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
	obj,
	remote,
	str,
} from "../../src/contracts/index.ts";
import { currentVariants, LOCAL } from "../../src/contracts/internal.ts";

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
