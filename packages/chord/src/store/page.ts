// Pages (decision "Query runner"; slice 14 §3.1): one page of a query read once, not live, with the opaque cursor
// that continues after it. A table handle's `page` and a named query's `page` are this.

import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import { decodeCursor, encodeCursor } from "./query.ts";
import type { ReadPlan, StoredRead } from "./read-plan.ts";
import type { ChordStore } from "./store.ts";

/** The stored rows of one page and, when more follow, the cursor to continue after it. */
export type StoredPage = { readonly stored: StoredRead[]; readonly next?: string };

/**
 * Up to `limit` rows of `plan`'s query after the cursor `after` (a trust boundary: an app hands it back), read
 * under the store's guard. `limit` is a positive integer (`invalid/args`).
 */
export async function readPage(
	store: ChordStore,
	plan: ReadPlan,
	limit: number,
	after: string | undefined,
	context: Context,
): Promise<StoredPage> {
	const { query, table, order } = plan;
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw invalid("args", `${query.table.name}: limit is a positive integer`);
	const from =
		after === undefined ? undefined : decodeCursor(query.table, table, order, after, (name) => query.column(name));
	// One row more than asked for: whether a further page exists.
	const statement = plan.select({ ...(from === undefined ? {} : { after: from }), limit: limit + 1 });
	const stored = await store.read((executor) => executor.all<StoredRead>(statement.sql, ...statement.params), context);
	if (stored.length <= limit) return { stored };
	stored.length = limit;
	const last = stored[limit - 1]!;
	return {
		stored,
		next: encodeCursor(
			table,
			order,
			order.columns.map((name) => last[name]!),
		),
	};
}
