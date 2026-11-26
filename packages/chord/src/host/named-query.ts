// Named queries (slice 14 §3.1): what `self.queries(table, options, builders)` returns, one `OwnQuery` per name, and
// what a reference shows for a `queries` member, one `ReferenceQuery` per name, each made by its first use (slice 15
// §5). A reader (`self.liveQuery`, `self.count`, `self.list`, `page`) asks either for the provider's declaration,
// checks its arguments, builds the query and reads it through the store.

import type { Context } from "../context/index.ts";
import type { QueryPage } from "../contracts/index.ts";
import type { QueriesData, Snapshot } from "../contracts/internal.ts";
import { canonicalJson, check, validatorFor } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { ColumnSet } from "../store/column-set.ts";
import type { ScalarColumn } from "../store/columns.ts";
import { partnerName } from "../store/expression.ts";
import type { QuerySpec } from "../store/open-query.ts";
import { readPage } from "../store/page.ts";
import { Query } from "../store/query.ts";
import { type Projection, ReadPlan, type ShapeSlot, type StoredRead } from "../store/read-plan.ts";
import { decodeScalar, versionColumn } from "../store/rows.ts";
import { type LiveTarget, SharedReads, type Sharing } from "../store/shared-read.ts";
import type { TableHandle } from "../store/table-handle.ts";
import type { Binding } from "./reference.ts";

/** A row of a joined set as a mapping gets it: the projected columns, decoded. */
export type PartnerRow = { readonly [column: string]: unknown };

/** What `self.queries` takes besides the table and the builders. */
export type QueriesOptions<R, T> = {
	/** Maps a row (and, for a joined query, its partner) to the item readers get; the row itself when left out. */
	readonly map?: (row: R, partner: PartnerRow) => T;
	/** The columns of the table `map` gets: only these (a change of another is no change of the item). All by default. */
	readonly reads?: readonly string[];
	/** The columns of a joined set `map` gets. All by default. */
	readonly partnerReads?: readonly string[];
};

/** A named query as readers hold it: its owner's declaration, or a reference's member. */
export abstract class NamedQueryHandle {
	/** The query in errors and reports: its name, with its member for a reference's. */
	abstract readonly label: string;

	/** The provider's declaration; throws while the provider is not live (a reference's state says why). */
	abstract provided(): OwnQuery;

	/** Calls `moved` whenever another instance of the provider is live, until the returned release. */
	abstract follow(moved: () => void): () => void;

	/** Up to `limit` items for `args` (after `options.after`), and the cursor of the next page when there is one. */
	page(
		args: unknown,
		limit: number,
		context: Context,
		options: { readonly after?: string } = {},
	): Promise<QueryPage<JsonValue>> {
		return this.provided().pageOf(args, limit, context, options.after);
	}
}

const NEVER_MOVES = (): void => {};

/**
 * A named query as its owner declared it: the table, the builder, the schema its arguments are checked by (the
 * contract's when the query is listed there, its own otherwise), the columns its mapping gets and the mapping.
 */
export class OwnQuery extends NamedQueryHandle {
	readonly label: string;
	readonly handle: TableHandle;
	readonly #builder: (args: unknown) => unknown;
	readonly #projection: Projection;
	readonly #map: ((row: unknown, partner: PartnerRow) => unknown) | undefined;
	/** Where its live reads share their plans' shape (a page, read once, takes none). */
	readonly #shapes: ShapeSlot = { last: undefined };
	/** Its open shared reads by shape and arguments: they go with it (with the provider's attempt). */
	readonly #shared = new SharedReads();
	/** The schema of its arguments: its own (a private query), or the contract's once its member was checked. */
	#args: Snapshot | undefined;
	#listed = false;

	constructor(
		owner: string,
		name: string,
		handle: TableHandle,
		builder: (args: unknown) => unknown,
		options: QueriesOptions<unknown, unknown>,
		args: Snapshot | undefined,
	) {
		super();
		this.label = `${owner}: query "${name}"`;
		this.handle = handle;
		this.#builder = builder;
		this.#projection = {
			...(options.reads === undefined ? {} : { reads: options.reads }),
			...(options.partnerReads === undefined ? {} : { partnerReads: options.partnerReads }),
		};
		this.#map = options.map;
		this.#args = args;
	}

	/** Whether its arguments have a schema: its own, or the contract's. */
	get checked(): boolean {
		return this.#args !== undefined;
	}

	provided(): OwnQuery {
		return this;
	}

	follow(): () => void {
		return NEVER_MOVES;
	}

	/**
	 * The contract lists this query with the argument schema `args` (the member check): a listed query brings no
	 * schema of its own (declaration policy).
	 */
	listed(args: Snapshot): void {
		if (this.#listed) return;
		if (this.#args !== undefined)
			throw new Error(`${this.label}: the contract has its argument schema; give only the builder`);
		this.#args = args;
		this.#listed = true;
	}

	/**
	 * What reading this query for `args` reads: `args` checked (a trust boundary), the query built and checked, shared
	 * with the other readers of these arguments by their canonical JSON.
	 */
	target(args: unknown, context: Context): NamedTarget {
		const query = this.#build(args, context);
		// Checked by the schema: JSON.
		const key = canonicalJson(args as JsonValue, context);
		return new OwnTarget(this, query, this.#projection, this.#shapes, this.#shared, key);
	}

	/** One page, read once: not live. */
	async pageOf(
		args: unknown,
		limit: number,
		context: Context,
		after: string | undefined,
	): Promise<QueryPage<JsonValue>> {
		const { handle } = this;
		handle.owner.assertLive();
		const query = this.#build(args, context);
		const plan = new ReadPlan(query, handle.sql.table, this.#projection, "rows", handle.store.reads);
		const page = await readPage(handle.store, plan, limit, after, context);
		const items = page.stored.map((row) => this.decodeRow(query, row, context));
		return page.next === undefined ? { items } : { items, next: page.next };
	}

	#build(args: unknown, context: Context): Query {
		const schema = this.#args;
		// Declaration policy: a query the contract does not list brings its schema (`name: [argsSchema, builder]`).
		if (schema === undefined) throw new Error(`${this.label}: a private query brings its argument schema`);
		check(validatorFor(schema, context), args, "args", context);
		// The builder is plugin code: what it returns is checked.
		const built = this.#builder(args);
		if (!(built instanceof Query) || built.table !== this.handle.definition) {
			throw new Error(`${this.label}: the builder returns a query of table "${this.handle.definition.name}"`);
		}
		return built;
	}

	/**
	 * A stored row as readers get it: the row (and partner) decoded and mapped. The statement also selects what the
	 * store needs (the key, the order and match columns): the mapping gets only the columns `reads` and
	 * `partnerReads` list, so a column it does not declare is absent, at once and visibly.
	 */
	decodeRow(query: Query, stored: StoredRead, context: Context): JsonValue {
		const { reads, partnerReads } = this.#projection;
		const { definition } = this.handle;
		const own = reads === undefined ? stored : projected(stored, reads);
		const row = definition.rows.decode(own, context);
		const joined = query.joined;
		const map = this.#map;
		// A table's rows hold its columns' values (scalars and JSON); a mapping's result is the item (its contract's).
		if (map === undefined) return row as JsonValue;
		return map(row, joined === undefined ? NO_PARTNER : partnerRow(joined.set, partnerReads, stored)) as JsonValue;
	}
}

/** What a named query's reader reads: a target shared by its arguments. */
export type NamedTarget = LiveTarget & { readonly sharing: Sharing };

/**
 * What a live read of a named query reads: the query built for its arguments, kept open as its own spec and shared
 * as its own sharing, decoding by its declaration. A class: a spec object and a decoding closure cost 208 B per read,
 * this 72 B.
 */
class OwnTarget implements NamedTarget, QuerySpec, Sharing {
	readonly query: Query;
	readonly table: string;
	readonly projection: Projection;
	readonly owner: TableHandle;
	readonly shapes: ShapeSlot;
	readonly shared: SharedReads;
	readonly args: string;
	readonly #own: OwnQuery;

	constructor(
		own: OwnQuery,
		query: Query,
		projection: Projection,
		shapes: ShapeSlot,
		shared: SharedReads,
		args: string,
	) {
		this.#own = own;
		this.query = query;
		this.table = own.handle.sql.table;
		this.projection = projection;
		this.owner = own.handle;
		this.shapes = shapes;
		this.shared = shared;
		this.args = args;
	}

	/** It is its own spec. */
	get spec(): QuerySpec {
		return this;
	}

	/** It is its own sharing. */
	get sharing(): Sharing {
		return this;
	}

	decode(stored: StoredRead, context: Context): JsonValue {
		return this.#own.decodeRow(this.query, stored, context);
	}
}

const NO_PARTNER: PartnerRow = {};

/** The columns `names` of `stored`, each `json(...)` one with its version column. */
function projected(stored: StoredRead, names: readonly string[]): StoredRead {
	const row: { [column: string]: StoredRead[string] } = {};
	for (const name of names) {
		row[name] = stored[name]!;
		const version = stored[versionColumn(name)];
		if (version !== undefined) row[versionColumn(name)] = version;
	}
	return row;
}

/** The joined set's columns `names` (all without) of `stored` (named `<set>:<column>` there), decoded. */
function partnerRow(set: ColumnSet, names: readonly string[] | undefined, stored: StoredRead): PartnerRow {
	const row: { [column: string]: unknown } = {};
	for (const name of names ?? set.byName.keys()) {
		const value = stored[partnerName(set.name, name)];
		// A set's columns are scalar (`defineColumns` refuses `json(...)`).
		if (value !== null && value !== undefined) row[name] = decodeScalar(set.byName.get(name) as ScalarColumn, value);
	}
	return row;
}

/**
 * A reference's `queries` member (slice 15 §5): its named queries, each made by its first use and kept as an own
 * property. A store offers many and a reader reads few, so a reference made pays for none it does not read.
 */
export function referenceQueries(binding: Binding, member: string, queries: QueriesData): object {
	let Queries = QUERIES_CLASSES.get(queries);
	if (Queries === undefined) {
		Queries = class extends ReferenceQueries {};
		for (const name of queries.args.keys()) {
			const get = function (this: ReferenceQueries): ReferenceQuery {
				return ReferenceQueries.make(this, name);
			};
			Object.defineProperty(Queries.prototype, name, { get, enumerable: true });
		}
		QUERIES_CLASSES.set(queries, Queries);
	}
	return new Queries(binding, member);
}

/**
 * The class of a `queries` member's object per member of a contract version (its `QueriesData`): a getter per name
 * on its prototype. Weak: a contract nobody holds takes its classes along.
 */
const QUERIES_CLASSES = new WeakMap<QueriesData, new (binding: Binding, member: string) => ReferenceQueries>();

/** What a `queries` member's object knows: the reference and the member; its names are its class's getters. */
class ReferenceQueries {
	readonly #binding: Binding;
	readonly #member: string;

	constructor(binding: Binding, member: string) {
		this.#binding = binding;
		this.#member = member;
	}

	/** The query `name` of `queries`, made now and kept as its own property (a static: no name of a query shadows it). */
	static make(queries: ReferenceQueries, name: string): ReferenceQuery {
		const query = new ReferenceQuery(queries.#binding, queries.#member, name);
		Object.defineProperty(queries, name, { value: query, enumerable: true });
		return query;
	}
}

/** A named query of a reference's `queries` member: the provider's declaration of that name, while it is live. */
export class ReferenceQuery extends NamedQueryHandle {
	readonly #binding: Binding;
	readonly #member: string;
	readonly #name: string;

	constructor(binding: Binding, member: string, name: string) {
		super();
		this.#binding = binding;
		this.#member = member;
		this.#name = name;
	}

	/** Built when asked: only error paths and reports read it (slice 15 §5). */
	get label(): string {
		return `${this.#binding.label}: query "${this.#member}.${this.#name}"`;
	}

	provided(): OwnQuery {
		return this.#binding.queryMember(this.#member, this.#name);
	}

	follow(moved: () => void): () => void {
		return this.#binding.followInstance(moved);
	}
}

/** The named queries of `value` when it is what `self.queries` returned: an object of `OwnQuery`s. */
export function ownQueries(value: unknown): ReadonlyMap<string, OwnQuery> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const entries = Object.entries(value);
	if (!entries.every(([, each]) => each instanceof OwnQuery)) return undefined;
	return new Map(entries as [string, OwnQuery][]);
}
