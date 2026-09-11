import {
	type ListElement,
	type ListReadOptions,
	resolveListReadOptions,
	type StoredValue,
	type Value,
	type ValueList,
	value,
} from "@earendil-works/pi-agent-core";
import { type SqlQuery, sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface ScalarValueRow {
	namespace: string;
	key: string;
	seq: number;
	value: string;
}

export interface ListValueRow {
	seq: number;
	value: string;
}

export function setScalarValueRow(
	db: SqliteDatabase,
	sessionId: string,
	namespace: string,
	key: string,
	seq: number,
	storedValue: unknown,
): void {
	sql`INSERT INTO scalar_values (session_id, namespace, key, seq, value)
		VALUES (${sessionId}, ${namespace}, ${key}, ${seq}, ${JSON.stringify(storedValue)})
		ON CONFLICT(session_id, namespace, key) DO UPDATE SET seq = excluded.seq, value = excluded.value`.run(db);
}

export function deleteScalarValueRow(db: SqliteDatabase, sessionId: string, namespace: string, key: string): void {
	sql`DELETE FROM scalar_values
		WHERE session_id = ${sessionId} AND namespace = ${namespace} AND key = ${key}`.run(db);
}

export function appendListValueRow(
	db: SqliteDatabase,
	sessionId: string,
	namespace: string,
	key: string,
	seq: number,
	element: unknown,
): void {
	sql`INSERT INTO list_values (session_id, namespace, key, seq, value)
		VALUES (${sessionId}, ${namespace}, ${key}, ${seq}, ${JSON.stringify(element)})`.run(db);
}

export function deleteListValueRows(db: SqliteDatabase, sessionId: string, namespace: string, key: string): void {
	sql`DELETE FROM list_values
		WHERE session_id = ${sessionId} AND namespace = ${namespace} AND key = ${key}`.run(db);
}

function decodeScalarValueRow<T>(address: Value<T>, row: ScalarValueRow): StoredValue<T> {
	if (row.namespace !== address.namespace || row.key !== address.key) {
		throw new Error(`Expected value ${address.namespace}:${address.key}, found ${row.namespace}:${row.key}`);
	}
	return { address, seq: row.seq, value: JSON.parse(row.value) as T };
}

export function readScalarValueRow<T>(
	db: SqliteDatabase,
	sessionId: string,
	address: Value<T>,
): StoredValue<T> | undefined {
	const row = sql`SELECT namespace, key, seq, value FROM scalar_values
		WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key}`.get<ScalarValueRow>(
		db,
	);
	return row === undefined ? undefined : decodeScalarValueRow(address, row);
}

export function readAllScalarValueRows(db: SqliteDatabase, sessionId: string): StoredValue<unknown>[] {
	return sql`SELECT namespace, key, seq, value FROM scalar_values
		WHERE session_id = ${sessionId} ORDER BY seq ASC`
		.all<ScalarValueRow>(db)
		.map((row) => ({
			address: value<unknown>(row.namespace, row.key),
			seq: row.seq,
			value: JSON.parse(row.value),
		}));
}

function nextPrefixBoundary(prefix: string): string | undefined {
	if (prefix === "") return undefined;
	const codePoints = Array.from(prefix);
	for (let index = codePoints.length - 1; index >= 0; index--) {
		const codePoint = codePoints[index]?.codePointAt(0);
		if (codePoint === undefined) throw new Error("Invalid value key prefix");
		if (codePoint < 0x10ffff) {
			const nextCodePoint = codePoint >= 0xd7ff && codePoint < 0xe000 ? 0xe000 : codePoint + 1;
			return `${codePoints.slice(0, index).join("")}${String.fromCodePoint(nextCodePoint)}`;
		}
	}
	return undefined;
}

export function scanScalarValueRows<T>(db: SqliteDatabase, sessionId: string, prefix: Value<T>): StoredValue<T>[] {
	const upperBound = nextPrefixBoundary(prefix.key);
	const rows =
		upperBound === undefined
			? sql`SELECT namespace, key, seq, value FROM scalar_values
				WHERE session_id = ${sessionId} AND namespace = ${prefix.namespace} AND key >= ${prefix.key}
				ORDER BY key ASC`.all<ScalarValueRow>(db)
			: sql`SELECT namespace, key, seq, value FROM scalar_values
				WHERE session_id = ${sessionId} AND namespace = ${prefix.namespace} AND key >= ${prefix.key} AND key < ${upperBound}
				ORDER BY key ASC`.all<ScalarValueRow>(db);
	return rows.map((row) => decodeScalarValueRow(value<T>(row.namespace, row.key), row));
}

export function listValueReadQuery<T>(sessionId: string, address: ValueList<T>, options?: ListReadOptions): SqlQuery {
	const resolved = resolveListReadOptions(options);
	if (resolved.order === "asc") {
		return resolved.cursor === undefined
			? sql`SELECT seq, value FROM list_values
				WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key}
				ORDER BY seq ASC LIMIT ${resolved.limit}`
			: sql`SELECT seq, value FROM list_values
				WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key} AND seq > ${resolved.cursor.seq}
				ORDER BY seq ASC LIMIT ${resolved.limit}`;
	}
	return resolved.cursor === undefined
		? sql`SELECT seq, value FROM list_values
			WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key}
			ORDER BY seq DESC LIMIT ${resolved.limit}`
		: sql`SELECT seq, value FROM list_values
			WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key} AND seq < ${resolved.cursor.seq}
			ORDER BY seq DESC LIMIT ${resolved.limit}`;
}

export function readListValueRows<T>(
	db: SqliteDatabase,
	sessionId: string,
	address: ValueList<T>,
	options?: ListReadOptions,
): ListElement<T>[] {
	return listValueReadQuery(sessionId, address, options)
		.all<ListValueRow>(db)
		.map((row) => ({ seq: row.seq, value: JSON.parse(row.value) as T }));
}
