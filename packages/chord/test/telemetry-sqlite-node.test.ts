// Tests of the read-only SQLite telemetry store on Node (`openTelemetryStore`): it reads what recorders of the file
// write, while they write, never writes the file, and refuses a file without a store or with one of another version.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { createSqliteTelemetry } from "../src/telemetry-sqlite/index.ts";
import { openTelemetryStore } from "../src/telemetry-sqlite/node.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chord-telemetry-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A recorder on `file` of its own database. */
async function recorder(file: string) {
	const db = await openNodeSqliteDatabase(file);
	const telemetry = await createSqliteTelemetry(db);
	return {
		telemetry,
		close: async () => {
			await telemetry.close();
			await db.close();
		},
	};
}

describe("the read-only store", () => {
	it("reads the traces and metrics recorders wrote, while one still records, and never writes the file", async () => {
		const file = join(dir, "telemetry.sqlite");
		const writing = await recorder(file);
		await writing.telemetry.startSpan({ name: "first" }, (span) => span.startSpan({ name: "child" }, () => {}));
		writing.telemetry.metrics.counter("hits").add(2);
		await writing.telemetry.flush();
		const store = await openTelemetryStore(file);
		const { traces } = await store.findTraces({ name: "first" });
		expect(traces.map(({ spans }) => spans.map(({ name }) => name))).toEqual([["first", "child"]]);
		expect(await store.getTrace(traces[0]!.traceId)).toEqual(traces[0]);
		// The recorder goes on: the reader sees each flush.
		await writing.telemetry.startSpan({ name: "second" }, () => {});
		await writing.close();
		expect((await store.findTraces()).traces.map(({ spans }) => spans[0]!.name)).toEqual(["second", "first"]);
		expect((await store.findMetrics({ name: "hits" })).map(({ sum }) => sum)).toEqual([2]);
		const before = readFileSync(file);
		await store.findTraces({ limit: 100 });
		await store.close();
		expect(readFileSync(file).equals(before)).toBe(true);
		await expect(store.findTraces()).rejects.toThrow();
	});

	it("refuses a missing file, a file without a store and a store of another version", async () => {
		await expect(openTelemetryStore(join(dir, "missing.sqlite"))).rejects.toThrow();
		const other = join(dir, "other.sqlite");
		const db = await openNodeSqliteDatabase(other);
		await db.exec("CREATE TABLE notes (id INTEGER)");
		await db.close();
		await expect(openTelemetryStore(other)).rejects.toThrow("not a telemetry store");
		const old = join(dir, "old.sqlite");
		await (await recorder(old)).close();
		const downgraded = await openNodeSqliteDatabase(old);
		await downgraded.run("UPDATE telemetry_schema SET version = 1");
		await downgraded.close();
		await expect(openTelemetryStore(old)).rejects.toThrow("telemetry store version 1, not 2");
		const newer = await openNodeSqliteDatabase(old);
		await newer.run("UPDATE telemetry_schema SET version = 3");
		await newer.close();
		await expect(openTelemetryStore(old)).rejects.toThrow("telemetry store version 3 is newer than this reader's 2");
	});
});
