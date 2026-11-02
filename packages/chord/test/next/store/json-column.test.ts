// `json(...)` columns (rule 8): their declaration, and a cell read and migrated on access.

import { describe, expect, it } from "vitest";
import { int, obj, str } from "../../../src/next/contracts/index.ts";
import { JsonColumn, json } from "../../../src/next/store/json-column.ts";
import { counted } from "../support.ts";

const MetaV1 = obj({ tag: str() });
const MetaV2 = obj({ tags: str(), n: int() });

describe("json(...)", () => {
	it("is a schema carrying its column: version and the fingerprint of the schema's normal form", () => {
		const column = (json(MetaV1, { version: 1 }) as unknown as { json: JsonColumn }).json;
		expect(column).toBeInstanceOf(JsonColumn);
		expect(column.version).toBe(1);
		const again = (json(obj({ tag: str({}) }), { version: 1 }) as unknown as { json: JsonColumn }).json;
		const other = (json(MetaV2, { version: 1 }) as unknown as { json: JsonColumn }).json;
		expect(again.fingerprint).toBe(column.fingerprint);
		expect(other.fingerprint).not.toBe(column.fingerprint);
	});

	it("refuses a version that is not a positive integer", () => {
		expect(() => json(MetaV1, { version: 0 })).toThrow("version 0");
	});
});

describe("reading a cell", () => {
	const v2 = new JsonColumn(MetaV2, 2, (old, from) => ({ tags: (old as { tag: string }).tag, n: from }));

	it("parses a cell of the current version with no check", async () => {
		const counts = await counted((context) => {
			expect(v2.read('{"tags":"a","n":1}', 2, "t.meta", context)).toEqual({ tags: "a", n: 1 });
		});
		expect(counts.validations).toBe(0);
	});

	it("migrates an older cell and checks the result once (R8)", async () => {
		const counts = await counted((context) => {
			expect(v2.read('{"tag":"x"}', 1, "t.meta", context)).toEqual({ tags: "x", n: 1 });
		});
		expect(counts.validations).toBe(1);
	});

	it("refuses a newer cell, a missing or throwing migrate and an invalid result", async () => {
		await counted((context) => {
			expect(() => v2.read("{}", 3, "t.meta", context)).toThrow("newer than 2");
			expect(() => new JsonColumn(MetaV2, 2, undefined).read("{}", 1, "t.meta", context)).toThrow("no migrate");
			const throwing = new JsonColumn(MetaV2, 2, () => {
				throw new Error("no");
			});
			expect(() => throwing.read("{}", 1, "t.meta", context)).toThrow("threw");
			const invalid = new JsonColumn(MetaV2, 2, () => ({ tags: 1, n: 1 }) as never);
			expect(() => invalid.read("{}", 1, "t.meta", context)).toThrow(
				expect.objectContaining({ code: "unavailable" }),
			);
		});
	});
});
