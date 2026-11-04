// biome-ignore-all lint/suspicious/noTemplateCurlyInString: TypeBox template literal syntax, as in the original tests.
// biome-ignore-all lint/correctness/noPrecisionLoss: the original tests' literal, kept as written.
// TypeBox 1.3.27's Value.Convert tests (test/typebox/runtime/value/convert, MIT, (c) Haydn Paterson), ported to the
// conversion pass of pi-schema's coercion. Schemas are still built with TypeBox: its schemas are JSON Schema, and the
// port reads only their JSON structure, never TypeBox's kind marks. Run with vitest.

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Coercer } from "../src/coerce.ts";
import { Compiler } from "../src/compiler.ts";
import { formats } from "../src/formats/index.ts";
import { compile } from "../src/index.ts";

/** Pass 2 alone, as TypeBox's Value.Convert(schema, value). */
function convert(schema: unknown, value: unknown): unknown {
	return new Coercer(new Compiler(schema as object, { formats }, false), schema).convertOnly(value);
}

const Value = {
	Convert: convert,
	Check: (schema: unknown, value: unknown) => compile(schema as object, { formats }).check(value),
};
const Convert = convert;
const Assert = {
	IsEqual: (actual: unknown, expected: unknown) => expect(actual).toEqual(expected),
	IsTrue: (value: boolean) => expect(value).toBe(true),
	IsFalse: (value: boolean) => expect(value).toBe(false),
};

describe("Value.Convert.Any", () => {
	it("Should Convert 1", () => {
		const T = Type.Any();
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 2", () => {
		const T = Type.Any();
		const R = Value.Convert(T, undefined);
		Assert.IsEqual(R, undefined);
	});
	it("Should Convert 3", () => {
		const T = Type.Any();
		const R = Value.Convert(T, "hello");
		Assert.IsEqual(R, "hello");
	});
	it("Should Convert 4", () => {
		const T = Type.Any();
		const R = Value.Convert(T, 42);
		Assert.IsEqual(R, 42);
	});
	it("Should Convert 5", () => {
		const T = Type.Any();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, true);
	});
	it("Should Convert 6", () => {
		const T = Type.Any();
		const R = Value.Convert(T, { x: 1 });
		Assert.IsEqual(R, { x: 1 });
	});
	it("Should Convert 7", () => {
		const T = Type.Any();
		const R = Value.Convert(T, [1, 2, 3]);
		Assert.IsEqual(R, [1, 2, 3]);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("Should Convert 8", () => {
		const S = Symbol("x-symbol");
		const T = Type.Symbol();
		const R = Value.Convert(T, S);
		Assert.IsEqual(R, S);
	});
});

describe("Value.Convert.Array", () => {
	it("Should Convert 1", () => {
		const T = Type.Array(Type.Number());
		const R = Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]);
		Assert.IsEqual(R, [1, 3.14, 1, 3.14, 1, 0, 1, 0, "hello"]);
	});
	it("Should Convert 2", () => {
		const T = Type.Array(Type.Boolean());
		const R = Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]);
		Assert.IsEqual(R, [true, 3.14, true, "3.14", true, false, true, false, "hello"]);
	});
	it("Should Convert 3", () => {
		const T = Type.Array(Type.String());
		const R = Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]);
		Assert.IsEqual(R, ["1", "3.14", "1", "3.14", "true", "false", "true", "false", "hello"]);
	});
	// ------------------------------------------------------------------
	// Added support for Array coercion
	//
	// https://github.com/sinclairzx81/typebox/issues/1469
	// ------------------------------------------------------------------
	it("Should Convert 4", () => {
		const T = Type.Array(Type.Number());
		const R = Value.Convert(T, "1");
		Assert.IsEqual(R, [1]);
	});
	it("Should Convert 5", () => {
		const T = Type.Array(Type.Number());
		const R = Value.Convert(T, []);
		Assert.IsEqual(R, []);
	});
	it("Should Convert 6", () => {
		const T = Type.Array(Type.Number());
		const R = Value.Convert(T, 42);
		Assert.IsEqual(R, [42]);
	});
	it("Should Convert 7", () => {
		const T = Type.Array(Type.Boolean());
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, [true]);
	});
	it("Should Convert 8", () => {
		const T = Type.Array(Type.Null());
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, [null]);
	});
	it("Should Convert 9", () => {
		const T = Type.Array(Type.Unknown());
		const R = Value.Convert(T, undefined);
		Assert.IsEqual(R, [undefined]);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("Should Convert 10", () => {
		const T = Type.Array(Type.BigInt());
		const R = Value.Convert(T, 1n);
		Assert.IsEqual(R, [1n]);
	});
	it("Should Convert 11", () => {
		const T = Type.Array(Type.Object({}));
		const R = Value.Convert(T, {});
		Assert.IsEqual(R, [{}]);
	});
	it("Should Convert 12", () => {
		const T = Type.Array(Type.Object({ x: Type.Number() }));
		const R = Value.Convert(T, { x: 1 });
		Assert.IsEqual(R, [{ x: 1 }]);
	});
	it("Should Convert 13", () => {
		const T = Type.Array(Type.Number());
		const R = Value.Convert(T, "42");
		Assert.IsEqual(R, [42]);
	});
	it("Should Convert 14", () => {
		const T = Type.Array(Type.Boolean());
		const R = Value.Convert(T, "true");
		Assert.IsEqual(R, [true]);
	});
	it("Should Convert 15", () => {
		const T = Type.Array(Type.Boolean());
		const R = Value.Convert(T, 0);
		Assert.IsEqual(R, [false]);
	});
	it("Should Convert 16", () => {
		const T = Type.Array(Type.Number());
		const R = Value.Convert(T, "hello");
		Assert.IsEqual(R, ["hello"]);
	});
	it("Should Convert 17", () => {
		const T = Type.Array(Type.Number());
		const R = Value.Convert(T, [1]);
		Assert.IsEqual(R, [1]);
	});
	it("Should Convert 18", () => {
		const T = Type.Array(Type.Array(Type.Number()));
		const R = Value.Convert(T, [1, 2, 3]);
		Assert.IsTrue(Value.Check(T, R));
	});
	it("Should Convert 19", () => {
		const T = Type.Array(Type.Number());
		const R = Value.Convert(T, { 0: 1, length: 1 });
		Assert.IsEqual(R, [{ 0: 1, length: 1 }]);
	});
	it("Should Convert 20", () => {
		const T = Type.Array(Type.Array(Type.Number()));
		const R = Value.Convert(T, 42);
		Assert.IsTrue(Value.Check(T, R));
	});
	// ------------------------------------------------------------------
	// Union
	// ------------------------------------------------------------------
	it("Should Convert 21", () => {
		const T = Type.Array(Type.Union([Type.Number(), Type.String()]));
		const R = Value.Convert(T, 1);
		Assert.IsTrue(Value.Check(T, R));
	});
	it("Should Convert 22", () => {
		const T = Type.Array(Type.Union([Type.Number(), Type.String()]));
		const R = Value.Convert(T, "hello");
		Assert.IsTrue(Value.Check(T, R));
	});
	it("Should Convert 23", () => {
		const T = Type.Array(Type.Union([Type.Number(), Type.String()]));
		const R = Value.Convert(T, [1, "hello", true, "3.14"]);
		Assert.IsTrue(Value.Check(T, R));
	});
	it("Should Convert 24", () => {
		const T = Type.Union([Type.Array(Type.Number()), Type.String()]);
		const R = Value.Convert(T, "1");
		Assert.IsTrue(Value.Check(T, R));
	});
	it("Should Convert 25", () => {
		const T = Type.Array(Type.Union([Type.Array(Type.Number()), Type.String()]));
		const R = Value.Convert(T, 42);
		Assert.IsTrue(Value.Check(T, R));
	});
	// ------------------------------------------------------------------
	// Embedded Intersect
	// ------------------------------------------------------------------
	it("Should Convert 26", () => {
		const T = Type.Array(Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]));
		const R = Value.Convert(T, { x: 1, y: 2 });
		Assert.IsTrue(Value.Check(T, R));
	});
	it("Should Convert 27", () => {
		const T = Type.Array(Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]));
		const R = Value.Convert(T, [
			{ x: "1", y: "2" },
			{ x: "3", y: "4" },
		]);
		Assert.IsTrue(Value.Check(T, R));
	});
	it("Should Convert 28", () => {
		const T = Type.Intersect([Type.Array(Type.Number()), Type.Array(Type.Number())]);
		const R = Value.Convert(T, 42);
		Assert.IsTrue(Value.Check(T, R));
	});
	it("Should Convert 29", () => {
		const T = Type.Intersect([Type.Array(Type.Number()), Type.Object({ x: Type.Number() })]);
		const R = Value.Convert(T, 42);
		Assert.IsFalse(Value.Check(T, R));
	});
});

describe("Value.Convert.Boolean", () => {
	it("Should Convert 1", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, "1");
		Assert.IsEqual(R, true);
	});
	it("Should Convert 2", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, "3.14");
		Assert.IsEqual(R, "3.14");
	});
	it("Should Convert 3", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, "true");
		Assert.IsEqual(R, true);
	});
	it("Should Convert 4", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, "false");
		Assert.IsEqual(R, false);
	});
	it("Should Convert 5", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, 1);
		Assert.IsEqual(R, true);
	});
	it("Should Convert 6", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, 3.14);
		Assert.IsEqual(R, 3.14);
	});
	it("Should Convert 7", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, 1.1);
		Assert.IsEqual(R, 1.1);
	});
	it("Should Convert 8", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, true);
	});
	it("Should Convert 9", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, false);
	});
	// ----------------------------------------------------------
	// Casts
	// ----------------------------------------------------------
	it("Should Convert 10", () => {
		const value = "hello";
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, "hello");
	});
	it("Should Convert 11", () => {
		const value = "true";
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, true);
	});
	it("Should Convert 12", () => {
		const value = "TRUE";
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, true);
	});
	it("Should Convert 13", () => {
		const value = "false";
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, false);
	});
	it("Should Convert 14", () => {
		const value = "0";
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, false);
	});
	it("Should Convert 15", () => {
		const value = "1";
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, true);
	});
	it("Should Convert 16", () => {
		const value = "0";
		const result = Value.Convert(Type.Boolean({ default: true }), value);
		Assert.IsEqual(result, false);
	});
	it("Should Convert 17", () => {
		const value = "1";
		const result = Value.Convert(Type.Boolean({ default: false }), value);
		Assert.IsEqual(result, true);
	});
	it("Should Convert 18", () => {
		const value = "2";
		const result = Value.Convert(Type.Boolean({ default: true }), value);
		Assert.IsEqual(result, "2");
	});
	it("Should Convert 19", () => {
		const value = 0;
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, false);
	});
	it("Should Convert 20", () => {
		const value = 1n;
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, true);
	});
	it("Should Convert 21", () => {
		const value = 1;
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, true);
	});
	it("Should Convert 22", () => {
		const value = 2;
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, 2);
	});
	it("Should Convert 23", () => {
		const value = 0;
		const result = Value.Convert(Type.Boolean({ default: true }), value);
		Assert.IsEqual(result, false);
	});
	it("Should Convert 24", () => {
		const value = 1;
		const result = Value.Convert(Type.Boolean({ default: false }), value);
		Assert.IsEqual(result, true);
	});
	it("Should Convert 25", () => {
		const value = 2;
		const result = Value.Convert(Type.Boolean({ default: true }), value);
		Assert.IsEqual(result, 2);
	});
	it("Should Convert 26", () => {
		const value = true;
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, true);
	});
	it("Should Convert 27", () => {
		const value = false;
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, false);
	});
	it("Should Convert 28", () => {
		const value = {};
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, {});
	});
	it("Should Convert 29", () => {
		const value = [] as any[];
		const result = Value.Convert(Type.Boolean(), value);
		Assert.IsEqual(result, []);
	});
	// ------------------------------------------------------------------
	// Coverage
	// ------------------------------------------------------------------
	it("Should Convert 17", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, BigInt(0));
		Assert.IsEqual(R, false);
	});
	it("Should Convert 18", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, BigInt(1));
		Assert.IsEqual(R, true);
	});
	it("Should Convert 19", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, BigInt(2));
		Assert.IsEqual(R, BigInt(2));
	});
	it("Should Convert 20", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, true);
	});
	it("Should Convert 21", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, false);
	});
	it("Should Convert 22", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, false);
	});
	it("Should Convert 23", () => {
		const T = Type.Boolean();
		const R = Value.Convert(T, undefined);
		Assert.IsEqual(R, false);
	});
});

describe("Value.Convert.Enum", () => {
	it("Should Convert 1", () => {
		const T = Type.Object({
			x: Type.Enum([1, 2, "hello"]),
		});
		const R0 = Value.Convert(T, { x: "1" });
		const R1 = Value.Convert(T, { x: "2" });
		const R2 = Value.Convert(T, { x: "hello" });
		const R3 = Value.Convert(T, { x: "world" });
		Assert.IsEqual(R0, { x: 1 });
		Assert.IsEqual(R1, { x: 2 });
		Assert.IsEqual(R2, { x: "hello" });
		Assert.IsEqual(R3, { x: "world" });
	});
});

describe("Value.Convert.Integer", () => {
	it("Should Convert 1", () => {
		const T = Type.Integer();
		const R = Value.Convert(T, "3.14");
		Assert.IsEqual(R, 3);
	});
	it("Should Convert 2", () => {
		const T = Type.Integer();
		const R = Value.Convert(T, "42");
		Assert.IsEqual(R, 42);
	});
	it("Should Convert 3", () => {
		const T = Type.Integer();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, 1);
	});
	it("Should Convert 4", () => {
		const T = Type.Integer();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, 0);
	});
	it("Should Convert 5", () => {
		const T = Type.Integer();
		const R = Value.Convert(T, 3.14);
		Assert.IsEqual(R, 3);
	});
	// ----------------------------------------------------------
	// Casts
	// ----------------------------------------------------------
	it("Should Convert 6", () => {
		const value = "hello";
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, "hello");
	});
	it("Should Convert 7", () => {
		const value = "3.14";
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, 3);
	});
	it("Should Convert 8", () => {
		const value = "-0";
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, -0);
	});
	it("Should Convert 9", () => {
		const value = "-100";
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, -100);
	});
	it("Should Convert 10", () => {
		const value = 42;
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, 42);
	});
	it("Should Convert 11", () => {
		const value = true;
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, 1);
	});
	it("Should Convert 12", () => {
		const value = false;
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, 0);
	});
	it("Should Convert 13", () => {
		const value = {};
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, {});
	});
	it("Should Convert 14", () => {
		const value = [] as any[];
		const result = Value.Convert(Type.Integer(), value);
		Assert.IsEqual(result, []);
	});
	// ----------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/1147
	// ----------------------------------------------------------
	it("Should Convert 15", () => {
		const N = 1738213389080;
		const R = Value.Convert(Type.Integer(), N);
		Assert.IsEqual(R, N);
	});
	it("Should Convert 16", () => {
		const N = 1738213389080.5555;
		const R = Value.Convert(Type.Integer(), N);
		Assert.IsEqual(R, 1738213389080);
	});
	it("Should Convert 17", () => {
		const N = "1738213389080";
		const R = Value.Convert(Type.Integer(), N);
		Assert.IsEqual(R, 1738213389080);
	});
	it("Should Convert 18", () => {
		const N = "1738213389080.555";
		const R = Value.Convert(Type.Integer(), N);
		Assert.IsEqual(R, 1738213389080);
	});
});

describe("Value.Convert.Intersect", () => {
	it("Should Convert intersected objects", () => {
		const T = Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]);
		const R = Value.Convert(T, { x: "1", y: "2" });
		Assert.IsEqual(R, { x: 1, y: 2 });
	});
	// ----------------------------------------------------------------
	// Intersection Complex
	// ----------------------------------------------------------------
	it("Should complex intersect 1", () => {
		const T = Type.Intersect([Type.Number(), Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]);
		const R = Value.Convert(T, { x: "1", y: "2" });
		Assert.IsEqual(R, { x: 1, y: 2 });
	});
	it("Should complex intersect 2", () => {
		const T = Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() }), Type.Number()]);
		const R = Value.Convert(T, { x: "3", y: "4" });
		Assert.IsEqual(R, { x: 3, y: 4 });
	});
	// Differs from TypeBox: allOf converts with each member in turn; TypeBox first merges an intersection into one object and drops the number.
	it("Should complex intersect 3", () => {
		const T = Type.Intersect([
			Type.Number(), // lost in Evaluate
			Type.Object({ x: Type.Number() }),
			Type.Object({ y: Type.Number() }),
		]);
		const R = Value.Convert(T, "123");
		Assert.IsEqual(R, 123);
	});
});

describe("Value.Convert.Literal", () => {
	it("LiteralString: Should convert 1", () => {
		const T = Type.Literal("1");
		const R = Value.Convert(T, 1);
		Assert.IsEqual(R, "1");
	});
	it("LiteralString: Should convert 2", () => {
		const T = Type.Literal("1");
		const R = Value.Convert(T, 2);
		Assert.IsEqual(R, 2);
	});
	it("LiteralString: Should convert 3", () => {
		const T = Type.Literal("true");
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, "true");
	});
	// ------------------------------------------------------------------
	// LiteralNumber
	// ------------------------------------------------------------------
	it("LiteralNumber: Should convert 1", () => {
		const T = Type.Literal(3.14);
		const R = Value.Convert(T, "3.14");
		Assert.IsEqual(R, 3.14);
	});
	it("LiteralNumber: Should convert 2", () => {
		const T = Type.Literal(3.14);
		const R = Value.Convert(T, "3.15");
		Assert.IsEqual(R, "3.15");
	});
	it("LiteralNumber: Should convert 3", () => {
		const T = Type.Literal(1);
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, 1);
	});
	it("LiteralNumber: Should convert 4", () => {
		const T = Type.Literal(0);
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, 0);
	});
	it("LiteralNumber: Should convert 5", () => {
		const T = Type.Literal(2);
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, true);
	});
	// ------------------------------------------------------------------
	// LiteralBoolean
	// ------------------------------------------------------------------
	it("LiteralBoolean: Should convert 1", () => {
		const T = Type.Literal(true);
		const R = Value.Convert(T, 3.14);
		Assert.IsEqual(R, 3.14);
	});
	it("LiteralBoolean: Should convert 2", () => {
		const T = Type.Literal(true);
		const R = Value.Convert(T, 1);
		Assert.IsEqual(R, true);
	});
	it("LiteralBoolean: Should convert 3", () => {
		const T = Type.Literal(true);
		const R = Value.Convert(T, "true");
		Assert.IsEqual(R, true);
	});
	it("LiteralBoolean: Should convert 4", () => {
		const T = Type.Literal(false);
		const R = Value.Convert(T, "false");
		Assert.IsEqual(R, false);
	});
	it("LiteralBoolean: Should convert 5", () => {
		const T = Type.Literal(true);
		const R = Value.Convert(T, "1");
		Assert.IsEqual(R, true);
	});
	it("LiteralBoolean: Should convert 6", () => {
		const T = Type.Literal(false);
		const R = Value.Convert(T, "0");
		Assert.IsEqual(R, false);
	});
	it("LiteralBoolean: Should convert 7", () => {
		const T = Type.Literal(false);
		const R = Value.Convert(T, "2");
		Assert.IsEqual(R, "2");
	});
	// ------------------------------------------------------------------
	// LiteralBigInt
	// ------------------------------------------------------------------
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 1", () => {
		const T = Type.Literal(100n);
		const R = Value.Convert(T, 100n);
		Assert.IsEqual(R, 100n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 2", () => {
		const T = Type.Literal(100n);
		const R = Value.Convert(T, 100);
		Assert.IsEqual(R, 100n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 3", () => {
		const T = Type.Literal(1n);
		const R = Value.Convert(T, "true");
		Assert.IsEqual(R, 1n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 4", () => {
		const T = Type.Literal(0n);
		const R = Value.Convert(T, "false");
		Assert.IsEqual(R, 0n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 5", () => {
		const T = Type.Literal(1n);
		const R = Value.Convert(T, "1");
		Assert.IsEqual(R, 1n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 6", () => {
		const T = Type.Literal(0n);
		const R = Value.Convert(T, "0");
		Assert.IsEqual(R, 0n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 7", () => {
		const T = Type.Literal(100n);
		const R = Value.Convert(T, "2");
		Assert.IsEqual(R, "2");
	});
	// ------------------------------------------------------------------
	// LiteralBigInt
	// ------------------------------------------------------------------
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 1", () => {
		const T = Type.Literal(100n);
		const R = Value.Convert(T, 100n);
		Assert.IsEqual(R, 100n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 2", () => {
		const T = Type.Literal(100n);
		const R = Value.Convert(T, 100);
		Assert.IsEqual(R, 100n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 3", () => {
		const T = Type.Literal(1n);
		const R = Value.Convert(T, "true");
		Assert.IsEqual(R, 1n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 4", () => {
		const T = Type.Literal(0n);
		const R = Value.Convert(T, "false");
		Assert.IsEqual(R, 0n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 5", () => {
		const T = Type.Literal(1n);
		const R = Value.Convert(T, "1");
		Assert.IsEqual(R, 1n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 6", () => {
		const T = Type.Literal(0n);
		const R = Value.Convert(T, "0");
		Assert.IsEqual(R, 0n);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("LiteralBigInt: Should convert 7", () => {
		const T = Type.Literal(100n);
		const R = Value.Convert(T, "2");
		Assert.IsEqual(R, "2");
	});
});

describe("Value.Convert.Never", () => {
	it("Should not 1", () => {
		const T = Type.Never();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, true);
	});
	it("Should not 2", () => {
		const T = Type.Never();
		const R = Value.Convert(T, 42);
		Assert.IsEqual(R, 42);
	});
	it("Should not 3", () => {
		const T = Type.Never();
		const R = Value.Convert(T, "true");
		Assert.IsEqual(R, "true");
	});
});

describe("Value.Convert.Null", () => {
	it("Should Convert 1", () => {
		const T = Type.Null();
		const R = Value.Convert(T, "null");
		Assert.IsEqual(R, null);
	});
	it("Should Convert 2", () => {
		const T = Type.Null();
		const R = Value.Convert(T, "NULL");
		Assert.IsEqual(R, null);
	});
	it("Should Convert 3", () => {
		const T = Type.Null();
		const R = Value.Convert(T, "nil");
		Assert.IsEqual(R, "nil");
	});
	it("Should Convert 4", () => {
		const T = Type.Null();
		const R = Value.Convert(T, "undefined");
		Assert.IsEqual(R, null);
	});
	it("Should Convert 5", () => {
		const T = Type.Null();
		const R = Value.Convert(T, "hello");
		Assert.IsEqual(R, "hello");
	});
	it("Should Convert 6", () => {
		const T = Type.Null();
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 7", () => {
		const T = Type.Null();
		const R = Value.Convert(T, 0);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 8", () => {
		const T = Type.Null();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 9", () => {
		const T = Type.Null();
		const R = Value.Convert(T, "");
		Assert.IsEqual(R, null);
	});
	// ------------------------------------------------------------------
	// Coverage
	// ------------------------------------------------------------------
	it("Should Convert 10", () => {
		const T = Type.Null();
		const R = Value.Convert(T, BigInt(0));
		Assert.IsEqual(R, null);
	});
	it("Should Convert 11", () => {
		const T = Type.Null();
		const R = Value.Convert(T, BigInt(1));
		Assert.IsEqual(R, BigInt(1));
	});
	it("Should Convert 12", () => {
		const T = Type.Null();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 13", () => {
		const T = Type.Null();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, true);
	});
	it("Should Convert 14", () => {
		const T = Type.Null();
		const R = Value.Convert(T, 0);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 15", () => {
		const T = Type.Null();
		const R = Value.Convert(T, 1);
		Assert.IsEqual(R, 1);
	});
	it("Should Convert 16", () => {
		const T = Type.Null();
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 17", () => {
		const T = Type.Null();
		const R = Value.Convert(T, undefined);
		Assert.IsEqual(R, null);
	});
	// Skipped: the schema or the value has no JSON form.
	it.skip("Should Convert 18", () => {
		const T = Type.Null();
		const S = Symbol("hello");
		const R = Value.Convert(T, S);
		Assert.IsEqual(R, S);
	});
});

describe("Value.Convert.Number", () => {
	it("Should Convert 1", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "3.14");
		Assert.IsEqual(R, 3.14);
	});
	it("Should Convert 2", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "42");
		Assert.IsEqual(R, 42);
	});
	it("Should Convert 3", () => {
		const T = Type.Number();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, 1);
	});
	it("Should Convert 4", () => {
		const T = Type.Number();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, 0);
	});
	it("Should Convert 5", () => {
		const T = Type.Number();
		const R = Value.Convert(T, 3.14);
		Assert.IsEqual(R, 3.14);
	});
	// ----------------------------------------------------------
	// Casts
	// ----------------------------------------------------------
	it("Should Convert 6", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "hello");
		Assert.IsEqual(R, "hello");
	});
	it("Should Convert 7", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "3.14");
		Assert.IsEqual(R, 3.14);
	});
	it("Should Convert 8", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "-0");
		Assert.IsEqual(R, -0);
	});
	it("Should Convert 9", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "-100");
		Assert.IsEqual(R, -100);
	});
	it("Should Convert 10", () => {
		const T = Type.Number();
		const R = Value.Convert(T, 42);
		Assert.IsEqual(R, 42);
	});
	it("Should Convert 11", () => {
		const T = Type.Number();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, 1);
	});
	it("Should Convert 12", () => {
		const T = Type.Number();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, 0);
	});
	it("Should Convert 13", () => {
		const T = Type.Number();
		const R = Value.Convert(T, {});
		Assert.IsEqual(R, {});
	});
	it("Should Convert 14", () => {
		const T = Type.Number();
		const R = Value.Convert(T, []);
		Assert.IsEqual(R, []);
	});
	// ------------------------------------------------------------------
	// Coverage
	// ------------------------------------------------------------------
	it("Should Convert 10", () => {
		const T = Type.Number();
		const R = Value.Convert(T, BigInt(0));
		Assert.IsEqual(R, 0);
	});
	it("Should Convert 11", () => {
		const T = Type.Number();
		const R = Value.Convert(T, BigInt(10000000000000000000000000000000000000000000000000000));
		Assert.IsEqual(R, BigInt(10000000000000000000000000000000000000000000000000000));
	});
	it("Should Convert 12", () => {
		const T = Type.Number();
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, 0);
	});
	it("Should Convert 13", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "false");
		Assert.IsEqual(R, 0);
	});
	it("Should Convert 14", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "true");
		Assert.IsEqual(R, 1);
	});
	it("Should Convert 15", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "123");
		Assert.IsEqual(R, 123);
	});
	it("Should Convert 16", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "123.456");
		Assert.IsEqual(R, 123.456);
	});
	it("Should Convert 17", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "123.456");
		Assert.IsEqual(R, 123.456);
	});
	it("Should Convert 18", () => {
		const T = Type.Number();
		const R = Value.Convert(T, "123n");
		Assert.IsEqual(R, 123);
	});
	it("Should Convert 19", () => {
		const T = Type.Number();
		const R = Value.Convert(T, undefined);
		Assert.IsEqual(R, 0);
	});
	it("Should Convert 20", () => {
		const T = Type.Number();
		const R = Value.Convert(T, `90071992547409910n`); // trailing 0 too large
		Assert.IsEqual(R, "90071992547409910n");
	});
});

describe("Value.Convert.Object", () => {
	it("Should Convert 1", () => {
		const T = Type.Object({
			x: Type.Number(),
			y: Type.Boolean(),
			z: Type.Boolean(),
		});
		const R = Value.Convert(T, { x: "42", y: "true", z: "hello" });
		Assert.IsEqual(R, { x: 42, y: true, z: "hello" });
	});
	it("Should Convert 2", () => {
		const T = Type.Object({
			x: Type.Number(),
			y: Type.Boolean(),
		});
		const R = Value.Convert(T, { x: "42", y: "true", z: "hello" });
		Assert.IsEqual(R, { x: 42, y: true, z: "hello" });
	});
	it("Should Convert 3", () => {
		const T = Type.Object({ x: Type.Number() });
		const R = Value.Convert(T, {});
		Assert.IsEqual(R, {});
	});
	it("Should Convert 4", () => {
		const T = Type.Object(
			{ x: Type.Number() },
			{
				additionalProperties: Type.Null(),
			},
		);
		const R = Value.Convert(T, { x: "1", y: 0 });
		Assert.IsEqual(R, { x: 1, y: null });
	});
	// ------------------------------------------------------------------
	// IsOptionalUndefined
	//
	// https://github.com/sinclairzx81/typebox/issues/1336#issuecomment-3312808962
	// ------------------------------------------------------------------
	it("Should Convert 5", () => {
		const T = Type.Object({ x: Type.Optional(Type.Number()) });
		const R = Value.Convert(T, { x: 1 });
		Assert.IsEqual(R, { x: 1 });
	});
	it("Should Convert 6", () => {
		const T = Type.Object({ x: Type.Optional(Type.Number()) });
		const R = Value.Convert(T, { x: "1" });
		Assert.IsEqual(R, { x: 1 });
	});
	it("Should Convert 7", () => {
		const T = Type.Object({ x: Type.Optional(Type.Number()) });
		const R = Value.Convert(T, { x: undefined });
		Assert.IsEqual(R, { x: undefined });
	});
});

describe("Value.Convert.Record", () => {
	it("Should Convert 1", () => {
		const T = Type.Record(Type.String(), Type.Number());
		const R = Value.Convert(T, { x: "42", y: "24", z: "hello" });
		Assert.IsEqual(R, { x: 42, y: 24, z: "hello" });
	});
	// ----------------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/930
	// ----------------------------------------------------------------
	it("Should Convert 2", () => {
		const T = Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())]);
		const R = Value.Convert(T, {});
		Assert.IsEqual(R, {});
	});
	it("Should Convert 3", () => {
		const T = Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()]);
		const R = Value.Convert(T, {});
		Assert.IsEqual(R, {});
	});
	it("Should Convert 4", () => {
		const T = Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())]);
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 5", () => {
		const T = Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()]);
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 6", () => {
		const T = Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())]);
		const R = Value.Convert(T, "NULL");
		Assert.IsEqual(R, null);
	});
	it("Should Convert 7", () => {
		const T = Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()]);
		const R = Value.Convert(T, "NULL");
		Assert.IsEqual(R, null);
	});
	it("Should Convert 8", () => {
		const T = Type.Record(Type.Number(), Type.Number(), {
			additionalProperties: Type.Null(),
		});
		const R = Value.Convert(T, { "0": "1", x: 0 });
		Assert.IsEqual(R, { "0": 1, x: null });
	});
});

describe("Value.Convert.String", () => {
	it("Should Convert 1", () => {
		const T = Type.String();
		const R = Value.Convert(T, 3.14);
		Assert.IsEqual(R, "3.14");
	});
	it("Should Convert 2", () => {
		const T = Type.String();
		const R = Value.Convert(T, 3);
		Assert.IsEqual(R, "3");
	});
	it("Should Convert 3", () => {
		const T = Type.String();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, "true");
	});
	it("Should Convert 4", () => {
		const T = Type.String();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, "false");
	});
	it("Should Convert 5", () => {
		const T = Type.String();
		const R = Value.Convert(T, BigInt(12345));
		Assert.IsEqual(R, "12345");
	});
	// ----------------------------------------------------------
	// Casts
	// ----------------------------------------------------------
	it("Should Convert 6", () => {
		const T = Type.String();
		const R = Value.Convert(T, "hello");
		Assert.IsEqual(R, "hello");
	});
	it("Should Convert 7", () => {
		const T = Type.String();
		const R = Value.Convert(T, 42);
		Assert.IsEqual(R, "42");
	});
	it("Should Convert 8", () => {
		const T = Type.String();
		const R = Value.Convert(T, 42n);
		Assert.IsEqual(R, "42");
	});
	it("Should Convert 9", () => {
		const T = Type.String();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, "true");
	});
	it("Should Convert 10", () => {
		const T = Type.String();
		const R = Value.Convert(T, false);
		Assert.IsEqual(R, "false");
	});
	it("Should Convert 11", () => {
		const T = Type.String();
		const R = Value.Convert(T, {});
		Assert.IsEqual(R, {});
	});
	it("Should Convert 12", () => {
		const T = Type.String();
		const R = Value.Convert(T, []);
		Assert.IsEqual(R, []);
	});
	// ------------------------------------------------------------------
	// Coverage
	// ------------------------------------------------------------------
	it("Should Convert 13", () => {
		const T = Type.String();
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, "null");
	});
	it("Should Convert 14", () => {
		const T = Type.String();
		const R = Value.Convert(T, undefined);
		Assert.IsEqual(R, "");
	});
});

describe("Value.Convert.TemplateLiteral", () => {
	// Differs from TypeBox: a template literal is a string with a pattern in JSON Schema; TypeBox converts a finite one as a union of literals.
	it("Should Convert 1", () => {
		const T = Type.TemplateLiteral("${1 | 2 | 3}");
		const R0 = Value.Convert(T, 1);
		const R1 = Value.Convert(T, 2);
		const R2 = Value.Convert(T, 3);
		const R3 = Value.Convert(T, 4);
		Assert.IsEqual(R0, "1");
		Assert.IsEqual(R1, "2");
		Assert.IsEqual(R2, "3");
		Assert.IsEqual(R3, "4");
	});
	// ------------------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/1510
	// ------------------------------------------------------------------
	it("Should Convert 2", () => {
		const T = Type.Object({
			test: Type.TemplateLiteral('${number}${"a"|"b"|"c"}'),
		});
		const R0 = Value.Convert(T, { test: "123b" });
		Assert.IsEqual(R0, { test: "123b" });
	});
});

describe("Value.Convert.Tuple", () => {
	it("Should Convert 1", () => {
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		const R = Value.Convert(T, ["1", "true"]);
		Assert.IsEqual(R, [1, 1]);
	});
	it("Should Convert 2", () => {
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		const R = Value.Convert(T, ["1"]);
		Assert.IsEqual(R, [1]);
	});
	it("Should Convert 3", () => {
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		const R = Value.Convert(T, ["1", "2", "3"]);
		Assert.IsEqual(R, [1, 2, "3"]);
	});
	it("Should Convert 4", () => {
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		const R = Value.Convert(T, "not an array");
		Assert.IsEqual(R, "not an array");
	});
	it("Should Convert 5", () => {
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		const R = Value.Convert(T, 42);
		Assert.IsEqual(R, 42);
	});
	it("Should Convert 6", () => {
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		const R = Value.Convert(T, null);
		Assert.IsEqual(R, null);
	});
	it("Should Convert 7", () => {
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		const R = Value.Convert(T, { 0: "1", 1: "2" });
		Assert.IsEqual(R, { 0: "1", 1: "2" });
	});
});

describe("Value.Convert.Union", () => {
	it("Should Convert 1", () => {
		const T = Type.Object({
			x: Type.Union([Type.Number(), Type.Null()]),
		});
		const R0 = Value.Convert(T, { x: "42" });
		const R1 = Value.Convert(T, { x: "null" });
		const R2 = Value.Convert(T, { x: "hello" });
		Assert.IsEqual(R0, { x: 42 });
		Assert.IsEqual(R1, { x: null });
		Assert.IsEqual(R2, { x: "hello" });
	});
	it("Should Convert 2", () => {
		const T = Type.Object({
			x: Type.Union([Type.Boolean(), Type.Number()]),
		});
		const R = Value.Convert(T, { x: "1" });
		Assert.IsEqual(R, { x: true });
	});

	// ----------------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/787
	// ----------------------------------------------------------------
	it("Should Convert 3", () => {
		const T = Type.Intersect([
			Type.Union([Type.Object({ a: Type.Number() }), Type.Object({ b: Type.Number() })]),
			Type.Object({ c: Type.Number() }),
		]);
		const R0 = Convert(T, { a: "1", c: "2" });
		const R1 = Convert(T, { b: "1", c: "2" });
		const R2 = Convert(T, { a: "1", b: "2", c: "3" });
		Assert.IsEqual(R0, { a: 1, c: 2 });
		Assert.IsEqual(R1, { b: 1, c: 2 });
		Assert.IsEqual(R2, { a: 1, b: "2", c: 3 }); // note: matching on first
	});
	// ----------------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/1295
	// ----------------------------------------------------------------
	it("Should guard against Array conversion in Object", () => {
		const T = Type.Union([
			Type.Object({
				type: Type.Literal("A"),
				values: Type.Union([Type.String(), Type.Number()]),
			}),
			Type.Object({
				type: Type.Literal("B"),
				values: Type.String(),
			}),
		]);
		const converted = Value.Convert(T, [{ type: "A", values: 1 }]);
		Assert.IsEqual(converted, [{ type: "A", values: 1 }]);
	});
	it("Should guard against Array conversion in Record", () => {
		const T = Type.Union([
			Type.Record(Type.String({ pattern: "^values$" }), Type.Union([Type.String(), Type.Number()])),
			Type.Record(Type.String({ pattern: "^type$" }), Type.Union([Type.String(), Type.Number()])),
		]);
		const converted = Value.Convert(T, [{ type: "A", values: 1 }]);
		Assert.IsEqual(converted, [{ type: "A", values: 1 }]);
	});
});

describe("Value.Convert.Unknown", () => {
	it("Should Convert 1", () => {
		const V = null;
		const T = Type.Unknown();
		const R = Value.Convert(T, V);
		Assert.IsEqual(R, V);
	});
	it("Should Convert 2", () => {
		const V = undefined;
		const T = Type.Unknown();
		const R = Value.Convert(T, V);
		Assert.IsEqual(R, V);
	});
	it("Should Convert 3", () => {
		const V = "hello";
		const T = Type.Unknown();
		const R = Value.Convert(T, V);
		Assert.IsEqual(R, V);
	});
	it("Should Convert 4", () => {
		const V = 42;
		const T = Type.Unknown();
		const R = Value.Convert(T, V);
		Assert.IsEqual(R, V);
	});
	it("Should Convert 5", () => {
		const T = Type.Unknown();
		const R = Value.Convert(T, true);
		Assert.IsEqual(R, true);
	});
	it("Should Convert 6", () => {
		const T = Type.Unknown();
		const R = Value.Convert(T, { x: 1 });
		Assert.IsEqual(R, { x: 1 });
	});
	it("Should Convert 7", () => {
		const T = Type.Unknown();
		const R = Value.Convert(T, [1, 2, 3]);
		Assert.IsEqual(R, [1, 2, 3]);
	});
});
