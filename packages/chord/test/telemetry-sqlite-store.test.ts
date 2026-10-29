import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telemetryStoreConformance } from "../../telemetry/test/store-conformance.ts";
import { DurableObjectSqliteDatabase } from "../src/sqlite/cloudflare.ts";
import type { SqliteExecutor, SqliteValue } from "../src/sqlite/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { createSqliteTelemetry } from "../src/telemetry-sqlite/index.ts";
import { durableObjectStorage } from "./sqlite/helpers.ts";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const db = await openNodeSqliteDatabase(":memory:");
	const context = await createSqliteTelemetry(db);
	return {
		db,
		context,
		store: context,
		flush: () => context.flush(),
		async [Symbol.asyncDispose]() {
			try {
				await context.close();
			} finally {
				await db.close();
			}
		},
	};
}

telemetryStoreConformance("SQLite telemetry store conformance", fixture);
telemetryStoreConformance("Durable Object SQLite telemetry store conformance", async () => {
	const sqlite = new DatabaseSync(":memory:");
	const db = new DurableObjectSqliteDatabase(durableObjectStorage(sqlite));
	const context = await createSqliteTelemetry(db);
	return {
		context,
		store: context,
		flush: () => context.flush(),
		async [Symbol.asyncDispose]() {
			try {
				await context.close();
				await db.close();
			} finally {
				sqlite.close();
			}
		},
	};
});

describe("SQLite telemetry reads", () => {
	it("uses two span queries for a page, not one query per trace", async () => {
		await using f = await fixture();
		for (let index = 0; index < 25; index++) await f.context.startSpan({ name: "root" }, () => {});
		await f.flush();
		let queries = 0;
		const original = f.db.transaction.bind(f.db);
		vi.spyOn(f.db, "transaction").mockImplementation((callback) =>
			original((tx) => {
				const counted: SqliteExecutor = {
					exec: (sql) => tx.exec(sql),
					run: (sql, ...params) => tx.run(sql, ...params),
					runCounted: (sql, ...params) => tx.runCounted(sql, ...params),
					get: <T extends object>(sql: string, ...params: SqliteValue[]) => tx.get<T>(sql, ...params),
					all: <T extends object>(sql: string, ...params: SqliteValue[]) => {
						queries++;
						return tx.all<T>(sql, ...params);
					},
				};
				return callback(counted);
			}),
		);
		expect((await f.context.findTraces({ limit: 20 })).traces).toHaveLength(20);
		expect(queries).toBe(2);
		queries = 0;
		expect((await f.context.findTraces({ limit: 1 })).traces).toHaveLength(1);
		expect(queries).toBe(2);
	});

	it("reads committed rows without implicitly flushing, including after close", async () => {
		await using f = await fixture();
		await f.context.startSpan({ name: "pending" }, () => {});
		expect((await f.context.findTraces()).traces).toEqual([]);
		f.context.metrics.counter("partial").add(2);
		expect(await f.context.findMetrics({ name: "partial" })).toEqual([]);
		await f.context.close();
		const trace = (await f.context.findTraces()).traces[0]!;
		expect((await f.context.getTrace(trace.traceId))?.spans[0]?.name).toBe("pending");
		expect(await f.context.findMetrics({ name: "partial" })).toMatchObject([{ count: 1, sum: 2 }]);
	});

	it("keeps surviving descendants discoverable after a stored parent is removed", async () => {
		await using f = await fixture();
		await f.context.startSpan({ name: "root" }, (root) => root.startSpan({ name: "child" }, () => {}));
		await f.flush();
		const original = (await f.context.findTraces()).traces[0]!;
		const parent = original.spans.find((span) => span.name === "root")!;
		await f.db.run("DELETE FROM telemetry_spans WHERE id = ?", parent.id);
		const trace = (await f.context.findTraces()).traces[0]!;
		expect(trace.traceId).toBe(original.traceId);
		expect(trace.spans).toHaveLength(1);
		expect(trace.spans[0]).toMatchObject({ name: "child", parentId: parent.id });
		expect((await f.context.getTrace(original.traceId))?.spans).toHaveLength(1);
	});
});
