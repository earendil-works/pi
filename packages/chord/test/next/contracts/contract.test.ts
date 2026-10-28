import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "../../../src/context/index.ts";
import { type Contract, contractData } from "../../../src/next/contracts/contract.ts";
import {
	arr,
	bytes,
	evolve,
	type Implementation,
	int,
	local,
	method,
	nul,
	obj,
	type ParamsOf,
	remote,
	str,
	union,
} from "../../../src/next/contracts/index.ts";
import { checkAccepts, currentVariants, LOCAL, takesNoArgs } from "../../../src/next/contracts/internal.ts";
import { bindProvider, checkParams } from "../../../src/next/data/internal.ts";
import type { Watchable } from "../../../src/next/state/index.ts";
import { expectCollected } from "../support.ts";

const Notes = remote("notes", {
	version: 1,
	params: { session: str(), page: int() },
	variants: {
		editor: { state: { notes: arr(str()) }, methods: { add: method(obj({ text: str() }), str()), clear: method() } },
		reader: { state: { notes: arr(str()) } },
	},
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

/** The members of one variant of a remote implementation. */
type Members<C extends Contract, V extends string> = Extract<Implementation<C>, { readonly variant: V }>["members"];

describe("derived types", () => {
	it("Implementation: one variant with its members, state watchables and methods taking args and a context", () => {
		expectTypeOf<Implementation<typeof Notes>["variant"]>().toEqualTypeOf<"editor" | "reader">();
		type Editor = Members<typeof Notes, "editor">;
		expectTypeOf<Editor["notes"]>().toEqualTypeOf<Watchable<string[]>>();
		expectTypeOf<Editor["add"]>().toEqualTypeOf<(args: { text: string }, context: Context) => Promise<string>>();
		// A method without arguments omits them.
		expectTypeOf<Editor["clear"]>().toEqualTypeOf<(context: Context) => Promise<null>>();
		expectTypeOf<keyof Members<typeof Notes, "reader">>().toEqualTypeOf<"notes">();
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
		const methods = [...currentVariants(Counts).get(LOCAL)!.methods].map(([name, data]) => [name, takesNoArgs(data)]);
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
