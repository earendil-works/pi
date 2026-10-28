import Type from "typebox";
import { describe, expect, it } from "vitest";
import { arr, evolve, int, keyed, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { currentVariants, LOCAL } from "../../../src/next/contracts/internal.ts";

const Note = obj({ text: str() });

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

	it.each([
		["empty name", "", { version: 1, params: {}, variants: { a: {} } }, 'A contract name "": expected lowercase'],
		[
			"name not a string",
			1,
			{ version: 1, params: {}, variants: { a: {} } },
			"A contract name 1: expected lowercase",
		],
		["an uppercase name", "Notes", { version: 1, params: {}, variants: { a: {} } }, "expected lowercase"],
		["a name with a colon", "a:b", { version: 1, params: {}, variants: { a: {} } }, "expected lowercase"],
		["version zero", "n", { version: 0, params: {}, variants: { a: {} } }, "n.version: expected a positive integer"],
		[
			"fractional version",
			"n",
			{ version: 1.5, params: {}, variants: { a: {} } },
			"n.version: expected a positive integer",
		],
		[
			"unsafe version",
			"n",
			{ version: 2 ** 53, params: {}, variants: { a: {} } },
			"n.version: expected a positive integer",
		],
		[
			"unknown declaration key",
			"n",
			{ version: 1, params: {}, variants: { a: {} }, place: "x" },
			'n: unknown key "place"',
		],
		[
			"a placement that is no function",
			"n",
			{ version: 1, params: {}, variants: { a: {} }, placement: "x" },
			"n.placement: expected a function of the params",
		],
		["no variants", "n", { version: 1, params: {}, variants: {} }, "n.variants: at least one variant is required"],
		["missing params", "n", { version: 1, variants: { a: {} } }, "n.params: expected an object"],
		[
			"unknown variant key",
			"n",
			{ version: 1, params: {}, variants: { a: { members: {} } } },
			'n.a: unknown key "members"',
		],
		[
			"a schema under methods",
			"n",
			{ version: 1, params: {}, variants: { a: { methods: { m: str() } } } },
			"n.a.methods.m: expected method(...)",
		],
		[
			"a method under state",
			"n",
			{ version: 1, params: {}, variants: { a: { state: { s: method() } } } },
			"n.a.state.s: a method belongs in methods",
		],
		[
			"bad state schema",
			"n",
			{ version: 1, params: {}, variants: { a: { state: { s: { not: {} } } } } },
			'n.a.state.s: unsupported keyword "not"',
		],
		[
			"open arguments",
			"n",
			{ version: 1, params: {}, variants: { a: { methods: { m: method(Type.Object({})) } } } },
			"n.a.methods.m.args: argument objects must be closed",
		],
		[
			"bad result",
			"n",
			{ version: 1, params: {}, variants: { a: { methods: { m: method(undefined, { not: {} }) } } } },
			'n.a.methods.m.result: unsupported keyword "not"',
		],
	])("remote refuses %s", (_case, name, declaration, message) => {
		expect(() => untyped.remote(name, declaration)).toThrow(message);
	});

	it.each([
		["unknown key", { version: 1, params: {}, members: {}, variants: {} }, 'i: unknown key "variants"'],
		["a placement", { version: 1, params: {}, members: {}, placement: () => null }, 'i: unknown key "placement"'],
		[
			"bad member schema",
			{ version: 1, params: {}, members: { s: { not: {} } } },
			'i.members.s: unsupported keyword "not"',
		],
		[
			"open arguments",
			{ version: 1, params: {}, members: { m: method(Type.Object({})) } },
			"i.members.m.args: argument objects must be closed",
		],
	])("local refuses %s", (_case, declaration, message) => {
		expect(() => untyped.local("i", declaration)).toThrow(message);
	});

	it("does not check state for closed objects", () => {
		expect(() => local("i", { version: 1, params: {}, members: { s: Type.Object({ a: str() }) } })).not.toThrow();
	});
});

describe("D11: members across variants", () => {
	it("refuses a name that is state in one variant and a method in another", () => {
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
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
				// @ts-expect-error: `m` takes a string in a and an integer in b
				variants: { a: { methods: { m: method(str()) } }, b: { methods: { m: method(int()) } } },
			}),
		).toThrow("n.b.methods.m: a method has the same signature in every variant");
		expect(() =>
			remote("n", {
				version: 1,
				params: {},
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
		expect(() => remote("n", { version: 1, params: {}, variants: { v: { state: { [name]: str() } } } })).toThrow(
			`n.v.state.${name}: "${name}" is reserved: a reference has it`,
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
				// @ts-expect-error keyed members are only in local contracts
				variants: { editor: { state: { notes: keyed(Note) } } },
			}),
		).toThrow("app.notes.editor.state.notes: keyed members are only in local contracts");
	});
});
