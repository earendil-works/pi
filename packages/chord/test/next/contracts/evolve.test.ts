import Type from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Context } from "../../../src/context/index.ts";
import { type Contract, contractData, type ShapeOf } from "../../../src/next/contracts/contract.ts";
import type { CurrentStep } from "../../../src/next/contracts/history.ts";
import {
	arr,
	bool,
	evolve,
	type Implementation,
	int,
	local,
	method,
	nul,
	obj,
	remote,
	type Static,
	str,
} from "../../../src/next/contracts/index.ts";

const Note = obj({ text: str() });

const NotesV1 = remote("notes", {
	version: 1,
	params: { session: str() },
	variants: {
		editor: { state: { notes: arr(Note), count: int() }, methods: { add: method(Note, str()), clear: method() } },
		reader: { state: { notes: arr(Note) }, methods: { add: method(Note, str()) } },
	},
});

const InfoV1 = local("info", { version: 1, params: {}, members: { title: str(), clear: method() } });

/** The current members of a contract's variant, as Chord holds them. */
function current(contract: Contract, variant: string) {
	const data = contractData(contract);
	const members = data.versions.at(-1)!.variants.get(variant)!;
	return { state: [...members.state.keys()], methods: [...members.methods.keys()], data };
}

/** The current version of a contract's type-level history. */
type VersionOf<C extends Contract> = CurrentStep<ShapeOf<C>["history"]>["version"];

/** The members of one variant of a remote implementation. */
type Members<C extends Contract, V extends string> = Extract<Implementation<C>, { readonly variant: V }>["members"];

describe("edits", () => {
	it("state changes one state member of one variant", () => {
		const v2 = evolve(NotesV1, (e) => e.state("editor", "count", str()));
		expect(v2.version).toBe(2);
		expectTypeOf<Members<typeof v2, "editor">["count"]["value"]>().toEqualTypeOf<string>();
		expectTypeOf<Members<typeof v2, "reader">["notes"]["value"]>().toEqualTypeOf<{ text: string }[]>();
		// @ts-expect-error: `missing` is not a state member of editor
		expect(() => evolve(NotesV1, (e) => e.state("editor", "missing", str()))).toThrow(
			"notes v2.editor.state.missing: no such state member",
		);
	});

	it("addState adds a state member", () => {
		const v2 = evolve(NotesV1, (e) => e.addState("reader", "count", int()));
		expect(current(v2, "reader").state).toEqual(["notes", "count"]);
		expectTypeOf<Members<typeof v2, "reader">["count"]["value"]>().toEqualTypeOf<number>();
		expect(() => evolve(NotesV1, (e) => e.addState("reader", "notes", int()))).toThrow(
			"notes v2.reader.state.notes: already declared",
		);
	});

	it("removeState removes a state member", () => {
		const v2 = evolve(NotesV1, (e) => e.removeState("editor", "count"));
		expect(current(v2, "editor").state).toEqual(["notes"]);
		expectTypeOf<keyof Members<typeof v2, "editor">>().toEqualTypeOf<"notes" | "add" | "clear">();
	});

	it("args and result change one side of a method in every variant that has it", () => {
		const v2 = evolve(NotesV1, (e) => e.args("add", obj({ text: str(), tag: str() })).result("add", int()));
		const { data } = current(v2, "editor");
		const editor = data.versions[1]!.variants.get("editor")!.methods.get("add")!;
		const reader = data.versions[1]!.variants.get("reader")!.methods.get("add")!;
		expect(editor).toEqual(reader);
		expect(data.versions[1]!.changes).toEqual([
			["editor", "add", "args"],
			["reader", "add", "args"],
			["editor", "add", "result"],
			["reader", "add", "result"],
		]);
		type Add = Members<typeof v2, "reader">["add"];
		expectTypeOf<Parameters<Add>[0]>().toEqualTypeOf<{ text: string; tag: string }>();
		expectTypeOf<Awaited<ReturnType<Add>>>().toEqualTypeOf<number>();
	});

	it("method replaces both sides", () => {
		const v2 = evolve(NotesV1, (e) => e.method("clear", obj({ all: bool() }), bool()));
		type Clear = Members<typeof v2, "editor">["clear"];
		expectTypeOf<Parameters<Clear>[0]>().toEqualTypeOf<{ all: boolean }>();
		expectTypeOf<Awaited<ReturnType<Clear>>>().toEqualTypeOf<boolean>();
		// @ts-expect-error: no method `missing`
		expect(() => evolve(NotesV1, (e) => e.method("missing", nul(), nul()))).toThrow('notes v2: no method "missing"');
	});

	it("addMethod adds a method; to another variant only with the same signature", () => {
		const v2 = evolve(NotesV1, (e) => e.addMethod("reader", "clear", nul(), nul()));
		expect(current(v2, "reader").methods).toEqual(["add", "clear"]);
		expect(() => evolve(NotesV1, (e) => e.addMethod("reader", "clear", str(), nul()))).toThrow(
			"notes v2.reader.methods.clear: a method has the same signature in every variant",
		);
		expect(() => evolve(NotesV1, (e) => e.addMethod("reader", "add", nul(), nul()))).toThrow(
			"notes v2.reader.methods.add: already declared",
		);
	});

	it("removeMethod removes a method from every variant", () => {
		const v2 = evolve(NotesV1, (e) => e.removeMethod("add"));
		expect(current(v2, "editor").methods).toEqual(["clear"]);
		expect(current(v2, "reader").methods).toEqual([]);
		expectTypeOf<keyof Members<typeof v2, "reader">>().toEqualTypeOf<"notes">();
	});

	it("local edits take no variant", () => {
		const v2 = evolve(InfoV1, (e) =>
			e
				.state("title", int())
				.addState("body", str())
				.addMethod("save", obj({ force: bool() }), nul())
				.removeMethod("clear"),
		);
		expect(current(v2, "members")).toMatchObject({ state: ["title", "body"], methods: ["save"] });
		expectTypeOf<keyof Implementation<typeof v2>>().toEqualTypeOf<"title" | "body" | "save">();
		const v3 = evolve(v2, (e) => e.removeState("body").args("save", nul()));
		// Arguments changed to `null`: the method omits them now.
		expectTypeOf<Parameters<Implementation<typeof v3>["save"]>>().toEqualTypeOf<[context: Context]>();
	});

	it("checks every edit: closed arguments and the vocabulary", () => {
		expect(() => evolve(NotesV1, (e) => e.args("add", Type.Object({ text: str() })))).toThrow(
			"notes v2.editor.methods.add.args: argument objects must be closed",
		);
		expect(() => evolve(InfoV1, (e) => e.addMethod("m", Type.Object({}), nul()))).toThrow(
			"info v2.members.m.args: argument objects must be closed",
		);
		expect(() => evolve(NotesV1, (e) => e.state("editor", "count", { not: {} } as never))).toThrow(
			'notes v2.editor.state.count: unsupported keyword "not"',
		);
		expect(() => evolve(NotesV1, (e) => e.state("editor", "count", Type.Object({})))).not.toThrow();
	});
});

describe("kinds and fixed parts", () => {
	it("a member's kind never changes, also not after a removal and re-add", () => {
		expect(() =>
			evolve(NotesV1, (e) => e.removeState("editor", "count").addMethod("editor", "count", nul(), nul())),
		).toThrow('notes v2.editor.methods.count: "count" is a state member; its kind never changes');
		const v2 = evolve(NotesV1, (e) => e.removeMethod("clear"));
		const v3 = evolve(v2, (e) => e.state("editor", "count", str()));
		expect(() => evolve(v3, (e) => e.addState("reader", "clear", str()))).toThrow(
			'notes v4.reader.state.clear: "clear" is a method member; its kind never changes',
		);
	});

	it("the variant set never changes", () => {
		// @ts-expect-error: no variant `admin`
		expect(() => evolve(NotesV1, (e) => e.addState("admin", "x", str()))).toThrow(
			"notes v2.admin: unknown variant (the variant set never changes)",
		);
	});

	it("a new base is a full declaration with an explicit version and no older versions", () => {
		const base = remote("notes", { version: 5, params: { session: str(), tenant: str() }, variants: { editor: {} } });
		expect(contractData(base).versions.map(({ version }) => version)).toEqual([5]);
		expect(evolve(base, (e) => e).version).toBe(6);
	});

	it("evolve must return the editor it was given", () => {
		const other = evolve(NotesV1, (e) => e);
		expect(other.version).toBe(2);
		let foreign: unknown;
		evolve(InfoV1, (e) => {
			foreign = e;
			return e;
		});
		expect(() => evolve(NotesV1, () => foreign as never)).toThrow(
			"notes v2: evolve must return the editor it was given",
		);
	});

	it("leaves the previous contract untouched", () => {
		evolve(NotesV1, (e) => e.removeState("editor", "count").removeMethod("add"));
		expect(current(NotesV1, "editor")).toMatchObject({ state: ["notes", "count"], methods: ["add", "clear"] });
	});
});

describe("long histories", () => {
	it("count versions beyond 9 and 99, at runtime and in the types", () => {
		let contract: Contract = InfoV1;
		for (let step = 0; step < 120; step++) contract = evolve(contract, (e) => e);
		expect(contract.version).toBe(121);
		expect(contractData(contract).versions).toHaveLength(121);

		const v9 = local("i", { version: 9, params: {}, members: { s: str() } });
		const v10 = evolve(v9, (e) => e);
		const v99 = local("i", { version: 99, params: {}, members: { s: str() } });
		const v100 = evolve(v99, (e) => e);
		const v101 = evolve(v100, (e) => e.state("s", int()));
		expectTypeOf<VersionOf<typeof v10>>().toEqualTypeOf<"10">();
		expectTypeOf<VersionOf<typeof v100>>().toEqualTypeOf<"100">();
		expectTypeOf<VersionOf<typeof v101>>().toEqualTypeOf<"101">();
	});

	it("the types track every step with its changes", () => {
		const v2 = evolve(NotesV1, (e) => e.state("editor", "count", str()).addMethod("reader", "clear", nul(), nul()));
		type History = ShapeOf<typeof v2>["history"];
		expectTypeOf<History["length"]>().toEqualTypeOf<2>();
		expectTypeOf<History[1]["changes"]>().toEqualTypeOf<
			["editor", "count", "state"] | ["reader", "clear", "args" | "result"]
		>();
		expectTypeOf<Static<History[0]["variants"]["editor"]["state"]["count"]>>().toEqualTypeOf<number>();
	});
});
