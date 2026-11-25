import { describe, expect, expectTypeOf, it } from "vitest";
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
import { checkAccepts, currentMembers, takesNoArgs } from "../../src/contracts/internal.ts";
import { bindProvider, checkParams } from "../../src/data/internal.ts";
import type { Watchable } from "../../src/state/index.ts";
import { expectCollected, Server } from "../support.ts";

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
