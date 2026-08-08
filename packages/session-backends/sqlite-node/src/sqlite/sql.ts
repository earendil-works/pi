import type { SqliteDatabase, SqliteRunResult } from "./types.ts";

type SqlTemplateValue = unknown | SqlQuery;

/** A parameterized SQLite query produced by {@link sql}. */
export class SqlQuery {
	readonly queryText: string;
	readonly params: readonly unknown[];

	constructor(queryText: string, params: readonly unknown[] = []) {
		this.queryText = queryText;
		this.params = params;
	}

	exec(db: SqliteDatabase): void {
		if (this.params.length > 0) throw new TypeError("SQLite exec queries cannot have parameters");
		db.exec(this.queryText);
	}

	run(db: SqliteDatabase): SqliteRunResult {
		return db.prepare(this.queryText).run(...this.params);
	}

	get<TRow extends object>(db: SqliteDatabase): TRow | undefined {
		return db.prepare(this.queryText).get<TRow>(...this.params);
	}

	all<TRow extends object>(db: SqliteDatabase): TRow[] {
		return db.prepare(this.queryText).all<TRow>(...this.params);
	}
}

/** Builds a parameterized query. Nested queries are inlined; other interpolations become `?` parameters. */
export function sql(strings: TemplateStringsArray, ...values: SqlTemplateValue[]): SqlQuery {
	let queryText = strings[0] ?? "";
	const params: unknown[] = [];
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value instanceof SqlQuery) {
			queryText += value.queryText;
			params.push(...value.params);
		} else {
			queryText += "?";
			params.push(value);
		}
		queryText += strings[index + 1] ?? "";
	}
	return new SqlQuery(queryText, params);
}

/** Joins trusted query fragments while preserving their parameter order. */
export function joinSqlFragments(fragments: readonly SqlQuery[], separator: string): SqlQuery {
	let queryText = "";
	const params: unknown[] = [];
	for (let index = 0; index < fragments.length; index++) {
		if (index > 0) queryText += separator;
		const fragment = fragments[index]!;
		queryText += fragment.queryText;
		params.push(...fragment.params);
	}
	return new SqlQuery(queryText, params);
}
