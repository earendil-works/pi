import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type StateDefinition } from "../../../src/next/documents/index.ts";
import { metered } from "../support.ts";

describe("defineState", () => {
	it("types the value and whether it is keyed", () => {
		const Notes = defineState("notes", {
			schema: obj({ list: arr(str()) }),
			version: 1,
			initial: () => ({ list: [] }),
		});
		const Drafts = defineState("drafts", {
			schema: obj({ n: int() }),
			version: 1,
			initial: () => ({ n: 0 }),
			keyed: true,
		});
		expectTypeOf(Notes).toEqualTypeOf<StateDefinition<{ list: string[] }, false>>();
		expectTypeOf(Drafts).toEqualTypeOf<StateDefinition<{ n: number }, true>>();
		expect([Notes.keyed, Drafts.keyed]).toEqual([false, true]);
	});

	it('takes a restricted name only: lowercase [a-z0-9@/._~-] (decision "Restricted names")', () => {
		const options = { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) };
		for (const name of ["@app/notes.v_1~x-y", "n"]) expect(defineState(name, options).name).toBe(name);
		for (const name of ["", "Notes", "app:notes", "app notes", "a\0b", "a\uD800", "é"]) {
			expect(() => defineState(name, options)).toThrow(
				`A state name ${JSON.stringify(name)}: expected lowercase [a-z0-9@/._~-]`,
			);
		}
		// Plugin code, not type-checked.
		expect(() => defineState(42 as never, options)).toThrow("A state name 42");
	});
});

describe("initial() (R8)", () => {
	it("is checked against the schema once, the first time it is used", async () => {
		const telemetry = await metered();
		const initial = vi.fn(() => ({ n: 0 }));
		const Doc = defineState("doc", { schema: obj({ n: int() }), version: 1, initial });
		expect(Doc.initial(telemetry.context)).toEqual({ n: 0 });
		expect(Doc.initial(telemetry.context)).toEqual({ n: 0 });
		expect(initial).toHaveBeenCalledTimes(2);
		expect(telemetry.counts()).toEqual({ "chord.data.compilations": 1, "chord.data.validations": 1 });
	});

	it("refuses a value that does not match, every time until one does", () => {
		let value: unknown = { n: "x" };
		const Doc = defineState("doc", { schema: obj({ n: int() }), version: 1, initial: () => value as { n: number } });
		expect(() => Doc.initial(context)).toThrow("doc: initial() does not match the schema");
		expect(() => Doc.initial(context)).toThrow("doc: initial() does not match the schema");
		value = { n: 1 };
		expect(Doc.initial(context)).toEqual({ n: 1 });
	});
});

describe("fingerprints", () => {
	it("are computed once from the schema's structure: descriptions ignored, a structural change seen", () => {
		const make = (schema: Parameters<typeof defineState>[1]["schema"]) =>
			defineState("doc", { schema, version: 1, initial: () => ({ n: 0 }) as never }).fingerprint;
		const plain = make(obj({ n: int() }));
		expect(plain).toMatch(/^[0-9a-f]{16}$/);
		expect(make(obj({ n: { ...int(), description: "a count" } }))).toBe(plain);
		expect(make(obj({ n: str() }))).not.toBe(plain);
	});
});

describe("migrate (R8)", () => {
	it("maps an older value and checks the result against the schema each time it produces one", async () => {
		const telemetry = await metered();
		const Doc = defineState("doc", {
			schema: obj({ n: int() }),
			version: 2,
			initial: () => ({ n: 0 }),
			migrate: (old, from) => ({ n: (old.count as number) * from }),
		});
		expect(Doc.migrate({ count: 3 }, 1, telemetry.context)).toEqual({ n: 3 });
		expect(() => Doc.migrate({ count: "x" }, 1, telemetry.context)).toThrow(
			"doc: migrate() from version 1 does not match the schema",
		);
		expect(telemetry.counts()["chord.data.validations"]).toBe(2);
	});

	it("refuses an older value without a migrate", () => {
		const Doc = defineState("doc", { schema: obj({ n: int() }), version: 2, initial: () => ({ n: 0 }) });
		expect(() => Doc.migrate({ n: 1 }, 1, context)).toThrow("doc: no migrate from version 1 to 2");
	});
});
