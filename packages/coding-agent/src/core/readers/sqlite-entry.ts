// Isolated SQLite reader process entry.
import { serveReader } from "./entry.ts";
import { readSqlite } from "./sqlite.ts";

serveReader(readSqlite);
