// `defineTable` (slice 6a §5): what a declaration materializes, the checks it makes, and its fingerprint.

import { describe, expect, it } from "vitest";
import { hostKind, int, obj, opt, str } from "../../src/contracts/index.ts";
import { host } from "../../src/store/host-column.ts";
import { json } from "../../src/store/json-column.ts";
import { defineTable, type KeyOf } from "../../src/store/table.ts";
import { evolveTable } from "../../src/store/table-evolve.ts";

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

describe("keys", () => {
	it("type an int() key column as a number and a str() one as a string (tutorial, 2026-11-03)", () => {
		const byNumber = { id: int(), text: str() };
		const key: KeyOf<typeof byNumber, ["id"]> = { id: 7 };
		const mixed: KeyOf<typeof columns, ["id", "at"]> = { id: "a", at: 1 };
		expect([key, mixed]).toEqual([{ id: 7 }, { id: "a", at: 1 }]);
	});
});

describe("host(...) columns", () => {
	const Session = hostKind("session", { id: str() });
	const User = hostKind("user", { id: str() });

	it("get the index `host` unless the key starts with them; a key with them is typed by addresses", () => {
		const pins = defineTable("pins", { version: 1, columns: { id: str(), session: host(Session) }, key: ["id"] });
		expect(pins.hostColumn?.name).toBe("session");
		expect([...pins.indexes]).toEqual([["host", ["session"]]]);
		const labels = defineTable("labels", {
			version: 1,
			columns: { session: host(Session), label: str() },
			key: ["session", "label"],
		});
		expect([...labels.indexes]).toEqual([]);
		const columns = { session: host(Session), label: str() };
		const key: KeyOf<typeof columns, ["session", "label"]> = { session: Session({ id: "S1" }), label: "a" };
		expect(labels.rows.key(key, "get").params).toEqual(["session|S1", "a"]);
	});

	it("keep their index across evolveTable, follow a rename and lose it with a drop", () => {
		const pins = defineTable("pins", {
			version: 1,
			columns: { id: str(), session: host(Session), note: opt(str()) },
			key: ["id"],
		});
		const renamed = evolveTable(pins, (t) => t.rename("session", "owner"));
		expect([...renamed.indexes]).toEqual([["host", ["owner"]]]);
		const dropped = evolveTable(renamed, (t) => t.drop("owner"));
		expect([...dropped.indexes]).toEqual([]);
		expect(dropped.hostColumn).toBeUndefined();
	});

	it("are one per table; the index name `host` is theirs; the kind is in the fingerprint", () => {
		expect(() =>
			defineTable("t", { version: 1, columns: { id: str(), a: host(Session), b: host(User) }, key: ["id"] }),
		).toThrow("more than one host(...) column");
		expect(() =>
			defineTable("t", {
				version: 1,
				columns: { id: str(), a: host(Session) },
				key: ["id"],
				indexes: { host: ["id"] },
			}),
		).toThrow(`index "host" is the host(...) column's own`);
		expect(() =>
			defineTable("t", { version: 1, columns: { id: str() }, key: ["id"], indexes: { host: ["id"] } }),
		).toThrow(`index "host" is the host(...) column's own`);
		const session = defineTable("t", { version: 1, columns: { id: str(), a: host(Session) }, key: ["id"] });
		const user = defineTable("t", { version: 1, columns: { id: str(), a: host(User) }, key: ["id"] });
		expect(session.fingerprint).not.toBe(user.fingerprint);
	});
});
