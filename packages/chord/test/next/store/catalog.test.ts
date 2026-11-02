// The catalog (slice 6a §8): the store's records of its tables, read once at open, changed after COMMIT returned.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, str } from "../../../src/next/contracts/index.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import { type ChordStore, openStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { stageTable } from "../../../src/next/store/table-writes.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { memoryStore, tableIn } from "../support.ts";

const Edits = defineTable("edits", {
	version: 1,
	columns: { id: str(), at: int() },
	key: ["id"],
	indexes: { by_at: ["at"] },
});
const TABLE = "app.store:edits";

describe("the catalog", () => {
	it("is read once at open: a reopened store knows its tables", async () => {
		const directory = await mkdtemp(join(tmpdir(), "chord-catalog-"));
		const path = join(directory, "store.sqlite");
		const first = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		await tableIn(first, Edits);
		await first.close(context);
		const second = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		expect(second.table(TABLE)).toEqual({
			table: TABLE,
			version: 1,
			state: "ready",
			columns: Edits.record,
			key: ["id"],
			fingerprint: Edits.fingerprint,
			indexes: { by_at: ["at"] },
		});
		await second.close(context);
		await rm(directory, { recursive: true, force: true });
	});

	it("changes in memory only after COMMIT returned", async () => {
		const store = await memoryStore();
		const { version, record: columns, key, fingerprint } = Edits;
		const failing: StagedWrite = {
			order: "write",
			apply: (step) =>
				step
					.run("INSERT INTO no_such_table VALUES (1)")
					.then(() => [{ kind: "dropIndex", table: TABLE, name: "x" }]),
		};
		const table = stageTable({ kind: "table", table: TABLE, version, state: "ready", columns, key, fingerprint });
		await expect(store.commit([table, failing], { admit: () => true, adopt: () => {} }, context)).rejects.toThrow(
			"no such table",
		);
		expect(store.table(TABLE)).toBeUndefined();
		await store.close(context);
	});
});
