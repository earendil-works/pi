/** Validate a prefix before using it as part of a SQLite identifier. */
export function validateSqliteSchemaPrefix(prefix: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
		throw new Error(`Invalid SQLite schema prefix ${JSON.stringify(prefix)}`);
	}
	if (prefix.toLowerCase().startsWith("sqlite_")) {
		throw new Error(`SQLite schema prefix ${JSON.stringify(prefix)} is reserved`);
	}
}
