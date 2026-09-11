import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./types.ts";

export async function applyInitialSchema(db: SqliteDatabase): Promise<void> {
	const migration = await readFile(fileURLToPath(new URL("./migrations/001_initial.sql", import.meta.url)), "utf8");
	db.exec(migration);
}
