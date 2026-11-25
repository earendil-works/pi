// equal(): JSON equality, a drop-in for TypeBox's Value.Equal.

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { equal } from "../src/index.ts";

describe("equal", () => {
	it("compares JSON values structurally, as TypeBox's Value.Equal does", () => {
		const cases: [unknown, unknown][] = [
			[1, 1],
			["a", "b"],
			[null, null],
			[null, undefined],
			[
				{ a: 1, b: [1, { c: 2 }] },
				{ b: [1, { c: 2 }], a: 1 },
			],
			[{ a: 1 }, { a: 1, b: 2 }],
			[
				[1, 2],
				[2, 1],
			],
			[[1], { 0: 1 }],
			[{}, []],
			[{ a: undefined }, {}],
		];
		for (const [a, b] of cases) expect(equal(a, b)).toBe(Value.Equal(a, b));
	});
});
