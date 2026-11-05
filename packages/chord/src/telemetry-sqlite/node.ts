// The SQLite telemetry store read-only, on Node (`@earendil-works/chord/telemetry-sqlite/node`): a store file that
// recorders of other processes write, opened for its reads (`TelemetryStore`) only.

import type { TelemetryStore } from "@earendil-works/pi-telemetry";
import { openNodeSqliteDatabase } from "../sqlite/node.ts";
import { assertTelemetryStore } from "./schema.ts";
import { findMetrics, findTraces, getTrace } from "./store.ts";

/** A telemetry store opened for reads: the store's reads, and the close of its file. */
export interface SqliteTelemetryStore extends TelemetryStore {
	/** Closes the file; reads after it reject. */
	close(): Promise<void>;
}

/**
 * Opens the telemetry store at `path` read-only (SQLite's read-only mode: it never writes the file, never migrates it,
 * never creates it), while recorders of other processes write it or after. Rejects for a file that holds no store or
 * a store of another version (a recorder, `createSqliteTelemetry`, migrates an older one).
 */
export async function openTelemetryStore(path: string): Promise<SqliteTelemetryStore> {
	const db = await openNodeSqliteDatabase(path, { mode: "read-only" });
	try {
		await assertTelemetryStore(db);
	} catch (error) {
		await db.close();
		throw error;
	}
	return {
		getTrace: (traceId) => getTrace(db, traceId),
		findTraces: (query) => findTraces(db, query),
		findMetrics: (query) => findMetrics(db, query),
		close: () => db.close(),
	};
}
