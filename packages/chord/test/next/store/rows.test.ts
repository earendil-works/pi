// Rows (slice 6a §5, §9): `put` rows and keys checked and encoded, stored rows decoded.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { bool, int, num, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { json } from "../../../src/next/store/json-column.ts";
import { defineTable } from "../../../src/next/store/table.ts";

const T = defineTable("t", {
	version: 3,
	columns: {
		id: str(),
		n: int({ default: 7 }),
		x: num(),
		b: bool(),
		note: opt(str()),
		meta: json(obj({ a: int() }), { version: 2 }),
	},
	key: ["id"],
});
const args = expect.objectContaining({ code: "invalid", reason: "args" });

describe("put rows", () => {
	it("encodes a row in physical order, defaults filled, booleans as 0 and 1, json serialized with its version", () => {
		const encoded = T.rows.put({ id: "a", x: 1.5, b: true, meta: { a: 1 } }, 3);
		expect(encoded.params).toEqual(["a", 7, 1.5, 1, null, '{"a":1}', 2, 3]);
		expect(encoded.row).toEqual({ id: "a", n: 7, x: 1.5, b: true, meta: { a: 1 } });
		expect(encoded.columns).toEqual({ meta: 2 });
		expect(encoded.id).toBe(T.rows.key({ id: "a" }, "get").id);
	});

	it("is a closed check: missing and unknown columns, wrong types, unsafe integers, non-finite numbers, NUL", () => {
		const row = { id: "a", x: 1, b: false, meta: {} };
		expect(() => T.rows.put({ ...row, id: undefined }, 3)).toThrow(args);
		expect(() => T.rows.put({ ...row, extra: 1 }, 3)).toThrow('unknown column "extra"');
		expect(() => T.rows.put({ ...row, n: 2 ** 53 }, 3)).toThrow(args);
		expect(() => T.rows.put({ ...row, n: 1.5 }, 3)).toThrow(args);
		expect(() => T.rows.put({ ...row, x: Number.POSITIVE_INFINITY }, 3)).toThrow(args);
		expect(() => T.rows.put({ ...row, b: 1 }, 3)).toThrow(args);
		expect(() => T.rows.put({ ...row, id: "a\0" }, 3)).toThrow("NUL");
		expect(() => T.rows.put({ ...row, note: null }, 3)).toThrow(args);
		expect(() => T.rows.put([], 3)).toThrow("expected an object");
	});

	it("serializes json cells at staging: a cycle or a BigInt fails there (rule 8)", () => {
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		expect(() => T.rows.put({ id: "a", x: 1, b: false, meta: cycle }, 3)).toThrow(args);
		expect(() => T.rows.put({ id: "a", x: 1, b: false, meta: { a: 1n } }, 3)).toThrow(args);
	});

	it("replaces lone surrogates in text", () => {
		expect(T.rows.put({ id: "a\uD800", x: 1, b: false, meta: {} }, 3).row.id).toBe("a\uFFFD");
	});
});

describe("keys", () => {
	it("takes exactly the key columns", () => {
		expect(T.rows.key({ id: "a" }, "get").params).toEqual(["a"]);
		expect(() => T.rows.key({}, "get")).toThrow("is missing");
		expect(() => T.rows.key({ id: "a", n: 1 }, "get")).toThrow('unknown column "n"');
		expect(() => T.rows.key({ id: 1 }, "get")).toThrow(args);
	});
});

describe("decoding", () => {
	it("reads booleans, leaves NULL opt columns absent and parses json cells", () => {
		const row = T.rows.decode({ id: "a", n: 1, x: 2, b: 0, note: null, meta: '{"a":1}', meta$v: 2 }, context);
		expect(row).toEqual({ id: "a", n: 1, x: 2, b: false, meta: { a: 1 } });
	});

	it("refuses a json cell of a newer version", () => {
		expect(() => T.rows.decode({ id: "a", n: 1, x: 2, b: 0, note: null, meta: "{}", meta$v: 3 }, context)).toThrow(
			"newer than 2",
		);
	});
});
