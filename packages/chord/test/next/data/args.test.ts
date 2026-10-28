import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "../../../src/context/index.ts";
import {
	type AcceptsTable,
	arr,
	bytes,
	evolve,
	int,
	local,
	method,
	nul,
	obj,
	remote,
	str,
} from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { bindProvider, type CheckedArgs, checkArgs, type Value } from "../../../src/next/data/internal.ts";
import { counted, expectCollected } from "../support.ts";

const Note = obj({ text: str() });
const NoteV2 = obj({ text: str(), tag: str() });

const NotesV1 = remote("notes", {
	version: 1,
	params: { session: str() },
	variants: {
		editor: {
			state: { notes: arr(Note) },
			methods: { add: method(Note, str()), clear: method(), attach: method(obj({ data: bytes({ max: 4 }) })) },
		},
		reader: { state: { notes: arr(Note) } },
	},
});
const NotesV2 = evolve(NotesV1, (e) => e.args("add", NoteV2).result("add", int()));
const NotesV3 = evolve(NotesV2, (e) => e.removeMethod("attach"));

const toV2 = vi.fn((old: { text: string }) => ({ ...old, tag: "v1" }));
const resultToOld = (current: number) => String(current);
const attach = async () => null;
const accepts: AcceptsTable<typeof NotesV3> = {
	1: { methods: { add: { args: toV2, result: resultToOld }, attach: { call: attach } } },
	2: { methods: { attach: "refuse" } },
};
const provider = bindProvider(NotesV3, accepts);

/** The error a refused check throws, as JSON. */
function refusal(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		if (isChordError(error)) return error.toJSON();
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("bindProvider", () => {
	it("checks the accepts table once and lists the accepted versions", () => {
		expect(provider.contract).toBe(NotesV3);
		expect(provider.accepted).toEqual([
			{ version: 1, fingerprint: NotesV1.fingerprint },
			{ version: 2, fingerprint: NotesV2.fingerprint },
		]);
		expect(() => bindProvider(NotesV3, { 1: {} } as never)).toThrow("notes accepts[1].methods.add: missing mapping");
	});

	it("compiles nothing and calls no mapping", async () => {
		const counts = await counted(() => bindProvider(NotesV3, accepts));
		expect(counts).toEqual({ walks: 0, validations: 0, compilations: 0 });
		expect(toV2).not.toHaveBeenCalled();
	});
});

describe("checkArgs", () => {
	it("returns current-version arguments as passed: no copy, never mapped", () => {
		const raw = { text: "t", tag: "x" };
		const checked = checkArgs(provider, "add", raw, 3, BACKGROUND_CONTEXT);
		expect(checked).toEqual({ kind: "method", args: raw, result: undefined });
		expect(checked.args).toBe(raw);
		expect(toV2).not.toHaveBeenCalled();
		expectTypeOf(checked).toEqualTypeOf<CheckedArgs<typeof NotesV3, "add">>();
		if (checked.kind === "method") expectTypeOf(checked.args).toEqualTypeOf<{ text: string; tag: string }>();
	});

	it("checks an old version against the old schema, then maps directly to the current shape", () => {
		const checked = checkArgs(provider, "add", { text: "t" }, 1, BACKGROUND_CONTEXT);
		expect(checked).toEqual({ kind: "method", args: { text: "t", tag: "v1" }, result: resultToOld });
		expect(refusal(() => checkArgs(provider, "add", { text: "t", tag: "x" }, 1, BACKGROUND_CONTEXT))).toMatchObject({
			code: "invalid",
			reason: "args",
			details: { path: "/tag" },
		});
		// Version 2 already has the current args: checked with that schema, not mapped.
		expect(checkArgs(provider, "add", { text: "t", tag: "x" }, 2, BACKGROUND_CONTEXT)).toEqual({
			kind: "method",
			args: { text: "t", tag: "x" },
			result: undefined,
		});
	});

	it("returns the old arguments with the call replacement; never invokes it", () => {
		const raw = { data: new Uint8Array(2) };
		expect(checkArgs(provider, "attach", raw, 1, BACKGROUND_CONTEXT)).toEqual({
			kind: "call",
			args: raw,
			call: attach,
		});
	});

	it("refuses unknown fields, nested ones too, and checks bytes by instanceof and length", () => {
		expect(
			refusal(() => checkArgs(provider, "add", { text: "t", tag: "x", extra: 1 }, 3, BACKGROUND_CONTEXT)),
		).toMatchObject({
			details: { path: "/extra" },
		});
		expect(refusal(() => checkArgs(provider, "attach", { data: [1, 2] }, 1, BACKGROUND_CONTEXT))).toMatchObject({
			details: { path: "/data" },
		});
		expect(
			refusal(() => checkArgs(provider, "attach", { data: new Uint8Array(5) }, 1, BACKGROUND_CONTEXT)),
		).toMatchObject({
			details: { path: "/data" },
		});
		const Nested = local("nested", { version: 1, params: {}, members: { m: method(obj({ a: obj({ b: str() }) })) } });
		const nested = bindProvider(Nested, {});
		expect(refusal(() => checkArgs(nested, "m", { a: { b: "x", c: 1 } }, 1, BACKGROUND_CONTEXT))).toMatchObject({
			details: { path: "/a/c" },
		});
	});

	it("takes null for no-argument methods", () => {
		expect(checkArgs(provider, "clear", null, 3, BACKGROUND_CONTEXT)).toEqual({
			kind: "method",
			args: null,
			result: undefined,
		});
		expect(refusal(() => checkArgs(provider, "clear", {}, 3, BACKGROUND_CONTEXT))).toMatchObject({
			code: "invalid",
			reason: "args",
			details: { path: "/" },
		});
	});

	it("checks local callers too", () => {
		const Info = local("info", { version: 1, params: {}, members: { save: method(obj({ title: str() }), nul()) } });
		const local1 = bindProvider(Info, {});
		expect(checkArgs(local1, "save", { title: "t" }, 1, BACKGROUND_CONTEXT).args).toEqual({ title: "t" });
		expect(refusal(() => checkArgs(local1, "save", { title: 1 }, 1, BACKGROUND_CONTEXT))).toMatchObject({
			message: "args/title: must be string",
		});
	});

	it("refuses an unknown method, an unaccepted version and a refused method", () => {
		expect(refusal(() => checkArgs(provider, "missing", null, 3, BACKGROUND_CONTEXT))).toEqual({
			code: "invalid",
			reason: "member",
			message: 'notes v3 has no method "missing"',
		});
		expect(refusal(() => checkArgs(provider, "attach", null, 3, BACKGROUND_CONTEXT))).toMatchObject({
			code: "invalid",
			reason: "member",
		});
		expect(refusal(() => checkArgs(provider, "add", { text: "t" }, 4, BACKGROUND_CONTEXT))).toEqual({
			code: "contract_mismatch",
			message: "notes v4 is not accepted",
		});
		expect(
			refusal(() => checkArgs(bindProvider(NotesV3, {}), "add", { text: "t" }, 1, BACKGROUND_CONTEXT)),
		).toMatchObject({
			code: "contract_mismatch",
		});
		expect(refusal(() => checkArgs(provider, "attach", { data: new Uint8Array() }, 2, BACKGROUND_CONTEXT))).toEqual({
			code: "contract_mismatch",
			message: 'notes v2 refuses "attach"',
		});
	});

	it("compiles lazily, once per accepted version and method; equal schema objects share a validator", async () => {
		const v1 = local("lazy", { version: 1, params: {}, members: { m: method(obj({ a: str() })), clear: method() } });
		const v2 = evolve(v1, (e) => e.args("m", obj({ a: str(), b: str() })));
		const fresh = bindProvider(v2, { 1: { methods: { m: { args: (old) => ({ ...old, b: "" }) } } } });
		const calls = [
			(context: Context) => checkArgs(fresh, "clear", null, 2, context),
			(context: Context) => checkArgs(fresh, "clear", null, 2, context),
			// Version 1 shares the unchanged `clear` schema object with version 2.
			(context: Context) => checkArgs(fresh, "clear", null, 1, context),
			(context: Context) => checkArgs(fresh, "m", { a: "x" }, 1, context),
			(context: Context) => checkArgs(fresh, "m", { a: "x" }, 1, context),
			(context: Context) => checkArgs(fresh, "m", { a: "x", b: "y" }, 2, context),
		];
		const compilations = [];
		for (const call of calls) compilations.push((await counted(call)).compilations);
		expect(compilations).toEqual([1, 0, 0, 1, 0, 1]);
	});

	it("counts one validation per call and no walk", async () => {
		const counts = await counted((context) => checkArgs(provider, "add", { text: "t" }, 1, context));
		expect(counts).toEqual({ walks: 0, validations: 1, compilations: 0 });
	});

	it("types a call replacement's arguments as values", () => {
		expectTypeOf<Extract<CheckedArgs<typeof NotesV3, "attach">, { kind: "call" }>["call"]>().toEqualTypeOf<
			(args: Value, context: Context) => Promise<Value>
		>();
	});
});

describe("memory", () => {
	it("a dropped binding releases its dispatch table, mappings, schemas and validators after the last call", async () => {
		const refs = await (async () => {
			const contract = evolve(
				local("gc", { version: 1, params: {}, members: { m: method(obj({ a: str() })) } }),
				(e) => e.args("m", obj({ a: str(), b: str() })),
			);
			const mapping = (old: { a: string }) => ({ ...old, b: "" });
			const bound = bindProvider(contract, { 1: { methods: { m: { args: mapping } } } });
			const pending = Promise.resolve(checkArgs(bound, "m", { a: "x" }, 1, BACKGROUND_CONTEXT));
			await pending;
			return [new WeakRef(contract), new WeakRef(bound), new WeakRef(mapping)];
		})();
		await expectCollected(...refs);
	});
});
