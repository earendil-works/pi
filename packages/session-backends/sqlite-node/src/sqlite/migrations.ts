import { INITIAL_SCHEMA_SQL } from "./migrations/schema.ts";
import type { SqliteDatabase } from "./types.ts";

export const SQLITE_STORAGE_VERSION = 1;

export async function applyInitialSchema(db: SqliteDatabase): Promise<void> {
	db.exec(INITIAL_SCHEMA_SQL);
}
