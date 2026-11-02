// Static for TypeBox-built schemas: the common kinds give TypeBox's own static type, without pi-schema importing
// TypeBox; other kinds give `unknown`. Type-level tests (they pass when this file type-checks), against TypeBox 1.3.27.

import { Type, type Static as TypeBoxOwn } from "typebox";
import { describe, expectTypeOf, it } from "vitest";
import { compile, type Static } from "../src/index.ts";

describe("Static of TypeBox schemas", () => {
	it("maps the primitive kinds, literals and Unsafe", () => {
		expectTypeOf<Static<ReturnType<typeof Type.String>>>().toEqualTypeOf<string>();
		expectTypeOf<Static<ReturnType<typeof Type.Number>>>().toEqualTypeOf<number>();
		expectTypeOf<Static<ReturnType<typeof Type.Integer>>>().toEqualTypeOf<number>();
		expectTypeOf<Static<ReturnType<typeof Type.Boolean>>>().toEqualTypeOf<boolean>();
		expectTypeOf<Static<ReturnType<typeof Type.Null>>>().toEqualTypeOf<null>();
		expectTypeOf<Static<ReturnType<typeof Type.Unknown>>>().toEqualTypeOf<unknown>();
		const any = Type.Any();
		expectTypeOf<Static<typeof any>>().toBeAny();
		const literal = Type.Literal("add");
		expectTypeOf<Static<typeof literal>>().toEqualTypeOf<"add">();
		const unsafe = Type.Unsafe<"a" | "b">({ type: "string", enum: ["a", "b"] });
		expectTypeOf<Static<typeof unsafe>>().toEqualTypeOf<"a" | "b">();
	});

	it("maps objects with optional and readonly properties as TypeBox does", () => {
		const schema = Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Integer()),
			id: Type.Readonly(Type.String()),
			tag: Type.Readonly(Type.Optional(Type.Literal("x"))),
		});
		type Expected = { path: string; offset?: number; readonly id: string; readonly tag?: "x" };
		expectTypeOf<Static<typeof schema>>().toEqualTypeOf<Expected>();
		expectTypeOf<Static<typeof schema>>().toEqualTypeOf<TypeBoxOwn<typeof schema>>();
		const empty = Type.Object({});
		expectTypeOf<Static<typeof empty>>().toEqualTypeOf<TypeBoxOwn<typeof empty>>();
	});

	it("maps arrays, unions and records, nested", () => {
		const schema = Type.Object({
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
			mode: Type.Union([Type.Literal("text"), Type.Literal("binary"), Type.Null()]),
			env: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
			counts: Type.Record(Type.Integer(), Type.Boolean()),
		});
		type Expected = {
			edits: { oldText: string; newText: string }[];
			mode: "text" | "binary" | null;
			env: Record<string, string | number>;
			counts: Record<number, boolean>;
		};
		expectTypeOf<Static<typeof schema>>().toEqualTypeOf<Expected>();
		expectTypeOf<Static<typeof schema>>().toEqualTypeOf<TypeBoxOwn<typeof schema>>();
	});

	it("gives unknown for kinds it does not map", () => {
		const enumeration = Type.Enum(["a", "b"]);
		const tuple = Type.Tuple([Type.String()]);
		const intersect = Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]);
		expectTypeOf<Static<typeof enumeration>>().toEqualTypeOf<unknown>();
		expectTypeOf<Static<typeof tuple>>().toEqualTypeOf<unknown>();
		expectTypeOf<Static<typeof intersect>>().toEqualTypeOf<unknown>();
		// Inside a mapped kind, an unmapped kind is unknown only where it stands.
		const object = Type.Object({ pair: Type.Tuple([Type.String()]), name: Type.String() });
		expectTypeOf<Static<typeof object>>().toEqualTypeOf<{ pair: unknown; name: string }>();
	});

	it("types compile() and parse() for TypeBox schemas", () => {
		const schema = Type.Object({ n: Type.Number(), s: Type.Optional(Type.String()) });
		const result = compile(schema, { coerce: true }).parse({ n: "1" });
		if (result.ok) expectTypeOf(result.value).toEqualTypeOf<{ n: number; s?: string }>();
	});
});
