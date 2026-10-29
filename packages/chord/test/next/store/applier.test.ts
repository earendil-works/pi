// Tests of the applier (slice 6a §13): recorded writes applied as recorded, checked against the store's own records:
// table names and columns by the name rules, indexes, rows against their recorded columns (NULL cells, defaults kept
// as stored, booleans, json(...) cells as JSON text) and documents with their ids kept.

import { describe, expect, it } from "vitest";
import { IdAllocator } from "../../../src/next/store/allocator.ts";
import { applyWrite } from "../../../src/next/store/applier.ts";
import { Step } from "../../../src/next/store/step.ts";
import type { StoreWrite } from "../../../src/next/store/writes.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { rejection } from "../support.ts";

const TABLE = "app.store:edits";

const table: StoreWrite = {
	kind: "table",
	table: TABLE,
	version: 2,
	state: "ready",
	columns: {
		id: { type: "str" },
		done: { type: "bool", default: false },
		note: { type: "str", optional: true },
		meta: { type: "json", optional: true, version: 1, fingerprint: "f" },
	},
	key: ["id"],
	fingerprint: "t",
};

/** Applies `writes` in one transaction of a fresh database; resolves with the rows of the table. */
async function applied(...writes: StoreWrite[]): Promise<unknown[]> {
	const db = await openNodeSqliteDatabase(":memory:");
	try {
		return await db.transaction(async (executor) => {
			const step = new Step(executor, 1, new IdAllocator(2), new Map());
			for (const write of writes) await applyWrite(step, write, "test");
			return executor.all(`SELECT * FROM "${TABLE}"`);
		});
	} finally {
		await db.close();
	}
}

describe("applied writes", () => {
	it("a table and its rows as recorded: NULL for absent opt cells, booleans as 0 and 1, json(...) as text", async () => {
		const rows = await applied(table, {
			kind: "put",
			table: TABLE,
			row: { id: "a", done: true, meta: { x: [1] } },
			version: 1,
			columns: { meta: 1 },
		});
		expect(rows).toEqual([{ id: "a", done: 1, note: null, meta: '{"x":[1]}', meta$v: 1, $v: 1 }]);
	});

	it.each<[string, StoreWrite[], string]>([
		[
			"a put for a table not recorded",
			[{ kind: "put", table: TABLE, row: {}, version: 1, columns: {} }],
			"is not recorded",
		],
		[
			"a key over an opt column",
			[{ ...table, key: ["note"] } as StoreWrite],
			'"note" is not a non-opt str or int column',
		],
		[
			"a json column without a fingerprint",
			[{ ...table, columns: { id: { type: "str" }, meta: { type: "json", version: 1 } } } as StoreWrite],
			"a json(...) column has a version and a fingerprint",
		],
		[
			"a default of another type",
			[{ ...table, columns: { id: { type: "str" }, n: { type: "int", default: "x" } } } as StoreWrite],
			"is not a int value",
		],
		[
			"an index over an unknown column",
			[table, { kind: "index", table: TABLE, name: "by_x", columns: ["x"] }],
			'"x" is not a non-opt str or int column',
		],
		[
			"an index twice",
			[
				table,
				{ kind: "index", table: TABLE, name: "by_id", columns: ["id"] },
				{ kind: "index", table: TABLE, name: "by_id", columns: ["id"] },
			],
			"not a new index name",
		],
		[
			"a version for a cell the row lacks",
			[table, { kind: "put", table: TABLE, row: { id: "a", done: false }, version: 1, columns: { meta: 1 } }],
			"no json(...) cell of the row",
		],
		[
			"a json cell that is no JSON",
			[
				table,
				{
					kind: "put",
					table: TABLE,
					row: { id: "a", done: false, meta: 1n as never },
					version: 1,
					columns: { meta: 1 },
				},
			],
			"not JSON",
		],
	])("refuses %s", async (_, writes, message) => {
		expect(await rejection(applied(...writes))).toMatchObject({
			code: "invalid",
			message: expect.stringContaining(message),
		});
	});
});
