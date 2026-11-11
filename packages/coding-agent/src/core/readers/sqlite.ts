// Browse SQLite snapshots using engine-parsed SELECT-only statements in an isolated process.
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { MAX_READER_TEXT_BYTES, type ReaderRequest, type ReaderResult } from "./protocol.ts";

type Cell = null | number | string | { type: "blob"; base64: string };

/** Return a schema overview or a bounded, read-only page of table/query results. */
export async function readSqlite(request: ReaderRequest): Promise<ReaderResult> {
	if (request.table && request.query) throw new Error("Specify either table or query, not both");
	if (request.params && !request.query) throw new Error("SQLite params require query");
	const database = new DatabaseSync(request.path, {
		readOnly: true,
		allowExtension: false,
		timeout: 1000,
		enableDoubleQuotedStringLiterals: false,
	});
	try {
		database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
		const source: Extract<ReaderResult["source"], { kind: "sqlite" }> = { kind: "sqlite", path: request.path };
		if (!request.table && !request.query) {
			const statement = database.prepare(
				"SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1001",
			);
			const rows = readRows(statement.iterate(), 1000);
			return {
				status: rows.more ? "partial" : "ok",
				text: JSON.stringify(
					{
						database: request.path,
						objects: rows.values,
						...(rows.more
							? { warning: "Schema exceeds 1000 objects; inspect a named table or query sqlite_schema directly" }
							: {}),
					},
					null,
					2,
				),
				images: [],
				source,
			};
		}
		const rowOffset = request.rowOffset ?? 0;
		const rowLimit = request.rowLimit ?? 100;
		let sql = request.query?.trim().replace(/;\s*$/, "");
		let tableColumns: Record<string, Cell>[] | undefined;
		if (request.table) {
			const object = database
				.prepare("SELECT type FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')")
				.get(request.table);
			if (!object) throw new Error(`SQLite table or view not found: ${request.table}`);
			tableColumns = readRows(
				database.prepare("SELECT * FROM pragma_table_xinfo(?)").iterate(request.table),
				2000,
			).values;
			const primaryKeys = tableColumns
				.filter((column) => Number(column.pk) > 0)
				.sort((a, b) => Number(a.pk) - Number(b.pk));
			sql = `SELECT * FROM ${quoteIdentifier(request.table)}${primaryKeys.length ? ` ORDER BY ${primaryKeys.map((column) => quoteIdentifier(String(column.name))).join(", ")}` : ""}`;
			source.table = request.table;
		}
		// The SQLite parser, not a keyword regex, enforces the SELECT grammar. Reject trailing
		// statements before stepping, even when user SQL closes our parenthesized subquery.
		const wrapped = `SELECT * FROM (\n${sql}\n) LIMIT ${rowLimit + 1} OFFSET ${rowOffset}`;
		const statement = database.prepare(wrapped);
		if (statement.sourceSQL.trim() !== wrapped.trim()) throw new Error("Only one read-only SQLite query is allowed");
		statement.setReadBigInts(true);
		const params = (request.params ?? []).map((value) => (typeof value === "boolean" ? Number(value) : value));
		const rows = readRows(statement.iterate(...params), rowLimit);
		source.rowOffset = rowOffset;
		source.rowLimit = rowLimit;
		if (rows.more) source.nextRowOffset = rowOffset + rows.values.length;
		return {
			status: "ok",
			text: JSON.stringify(
				{
					database: request.path,
					...(request.table ? { table: request.table, schema: tableColumns } : {}),
					columns: statement.columns().map((column) => ({ name: column.name, type: column.type })),
					rowOffset,
					rows: rows.values,
					...(rows.more ? { nextRowOffset: source.nextRowOffset } : {}),
					encoding: "Unsafe integers are decimal strings; blobs are {type:blob,base64:...}",
				},
				null,
				2,
			),
			images: [],
			source,
		};
	} finally {
		database.close();
	}
}

function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function readRows(
	iterator: Iterable<Record<string, SQLOutputValue>>,
	limit: number,
): { values: Record<string, Cell>[]; more: boolean } {
	const values: Record<string, Cell>[] = [];
	let size = 0;
	for (const row of iterator) {
		if (values.length === limit) return { values, more: true };
		const converted: Record<string, Cell> = Object.create(null);
		for (const [key, value] of Object.entries(row)) {
			// SQLite is a data boundary: preserve 64-bit integers and arbitrary blob bytes.
			if (typeof value === "bigint")
				converted[key] =
					value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
						? Number(value)
						: value.toString();
			else if (value instanceof Uint8Array)
				converted[key] = {
					type: "blob",
					base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
				};
			else converted[key] = value;
		}
		size += Buffer.byteLength(JSON.stringify(converted));
		if (size > MAX_READER_TEXT_BYTES / 2)
			throw new Error("SQLite results exceed 4 MiB; select fewer rows or omit large columns");
		values.push(converted);
	}
	return { values, more: false };
}
