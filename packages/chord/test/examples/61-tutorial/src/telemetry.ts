// The todo app's telemetry store: one SQLite file in the data directory, `telemetry.sqlite`. The server is its only
// writer: its own spans, and those every list's worker and every recording page send it; readers (the trace viewer,
// `trace.ts`) open it read-only with Chord's `openTelemetryStore` and read through the store's read interface.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openNodeSqliteDatabase } from "../../../../src/sqlite/node.ts";
import { createSqliteTelemetry, type SqliteTelemetry } from "../../../../src/telemetry-sqlite/index.ts";

/** The telemetry store as one process opened it: its recorder (an adapter and the reads) and its close. */
export type TodoTelemetry = {
	readonly store: SqliteTelemetry;
	/** Flushes what the recorder still holds and closes the file. */
	close(): Promise<void>;
};

/** The telemetry store's file in the data directory `dataDir`. */
export function telemetryFile(dataDir: string): string {
	return join(dataDir, "telemetry.sqlite");
}

/** Opens the telemetry store at `file` for this process (its directory made, private, when missing). */
export async function openTelemetry(file: string): Promise<TodoTelemetry> {
	// Spans carry who called what: the data directory is private before the store's first file appears in it.
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const db = await openNodeSqliteDatabase(file);
	const store = await createSqliteTelemetry(db);
	return {
		store,
		close: async () => {
			await store.close();
			await db.close();
		},
	};
}
