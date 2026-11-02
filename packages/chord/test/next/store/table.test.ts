// `defineTable` (slice 6a §5): what a declaration materializes, the checks it makes, and its fingerprint.

import { describe, expect, it } from "vitest";
import { int, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { json } from "../../../src/next/store/json-column.ts";
import { defineTable } from "../../../src/next/store/table.ts";

const columns = { id: str(), path: str(), at: int(), note: opt(str()), meta: json(obj({}), { version: 1 }) };

describe("defineTable", () => {
	it("materializes columns, key, indexes and the record", () => {
		const Edits = defineTable("edits", { version: 2, columns, key: ["id"], indexes: { by_path: ["path", "at"] } });
		expect(Edits.name).toBe("edits");
		expect(Edits.version).toBe(2);
		expect(Edits.key).toEqual(["id"]);
		expect([...Edits.indexes]).toEqual([["by_path", ["path", "at"]]]);
		expect(Object.keys(Edits.record)).toEqual(["id", "path", "at", "note", "meta"]);
		expect(Edits.rows.physical).toEqual(["id", "path", "at", "note", "meta", "meta$v", "$v"]);
	});

	it("checks the table name, the version, key, index names and index columns", () => {
		expect(() => defineTable("Edits", { version: 1, columns, key: ["id"] })).toThrow("expected lowercase");
		expect(() => defineTable("a:b", { version: 1, columns, key: ["id"] })).toThrow("expected lowercase");
		expect(defineTable("@pi/file-history.edits", { version: 1, columns, key: ["id"] }).name).toBe(
			"@pi/file-history.edits",
		);
		expect(() => defineTable("edits", { version: 0, columns, key: ["id"] })).toThrow("positive integer");
		expect(() => defineTable("edits", { version: 1, columns, key: [] })).toThrow("no column");
		expect(() => defineTable("edits", { version: 1, columns, key: ["note" as "id"] })).toThrow(
			"non-opt str() or int()",
		);
		expect(() => defineTable("edits", { version: 1, columns, key: ["meta" as "id"] })).toThrow(
			"non-opt str() or int()",
		);
		expect(() => defineTable("edits", { version: 1, columns, key: ["id", "id"] })).toThrow("occurs twice");
		expect(() => defineTable("edits", { version: 1, columns, key: ["nope" as "id"] })).toThrow('no column "nope"');
		expect(() => defineTable("edits", { version: 1, columns, key: ["id"], indexes: { ByPath: ["path"] } })).toThrow(
			"[a-z0-9_]+",
		);
		expect(() =>
			defineTable("edits", { version: 1, columns, key: ["id"], indexes: { by: ["note" as "path"] } }),
		).toThrow("non-opt");
	});

	it("fingerprints columns, key and indexes, not their declaration order", () => {
		const a = defineTable("edits", { version: 1, columns, key: ["id"], indexes: { x: ["path"], y: ["at"] } });
		const reordered = { meta: columns.meta, note: columns.note, at: columns.at, path: columns.path, id: columns.id };
		const b = defineTable("edits", {
			version: 1,
			columns: reordered,
			key: ["id"],
			indexes: { y: ["at"], x: ["path"] },
		});
		expect(b.fingerprint).toBe(a.fingerprint);
		expect(defineTable("edits", { version: 1, columns, key: ["id"] }).fingerprint).not.toBe(a.fingerprint);
		expect(
			defineTable("edits", { version: 1, columns, key: ["id", "at"], indexes: { x: ["path"], y: ["at"] } })
				.fingerprint,
		).not.toBe(a.fingerprint);
		const otherMeta = { ...columns, meta: json(obj({ a: int() }), { version: 1 }) };
		expect(
			defineTable("edits", { version: 1, columns: otherMeta, key: ["id"], indexes: { x: ["path"], y: ["at"] } })
				.fingerprint,
		).not.toBe(a.fingerprint);
	});
});
