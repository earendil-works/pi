// The declarations of reads (slice 14 §3, §4): what `self.queries`, `self.liveQuery`, `self.count` and `self.list`
// check and build. The checks are pure, so an attempt and staging's recording `self` make the same ones (a reload
// whose new code declares a read wrongly keeps the plugin on its old code); the builders make what an attempt opens.

import type { Context } from "../context/index.ts";
import type { Snapshot } from "../contracts/internal.ts";
import { snapshotArguments } from "../contracts/internal.ts";
import { ChordError } from "../data/index.ts";
import { asChordError, waitingFor } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { Dependent } from "../state/internal.ts";
import { LiveQuery, type LiveShape } from "../store/live-query.ts";
import type { ReadSite } from "../store/open-query.ts";
import { type Blocked, type Parking, waitingOn } from "./dependencies.ts";
import type { AnyHost } from "./host.ts";
import { List, type ListMemory } from "./list.ts";
import { NamedQueryHandle } from "./named-query.ts";
import { type GivenArguments, GivenQuery, Reader } from "./query-reader.ts";
import { LOADING } from "./ref-state.ts";
import { resolveWatchable } from "./reference.ts";

/** Every reader has a value: the shared answer. */
const READY: Parking = { kind: "ready" };

/**
 * Opens each of `readers` in turn (slice 14 §3.2), named to `long` as `label` while its first run is awaited, as one
 * step of a parked attempt (or of an admission): ready once all have values; else parked on the first that is not,
 * `loading` while its read has not run yet (a table it reads is being created or migrated), `failed { waiting }` on
 * a read it waits on; or broken (its own code). Parked, it says why (`cause`), as a parked dependency does: an
 * admission parked on a read is its attempt's first check, which a reload's report waits for. A reader that is not
 * ready is followed by `wake` from then on: its next adoption (its table ready, a good run after a failed one)
 * checks again.
 */
export async function openReaders(
	readers: readonly Reader[],
	wake: Dependent,
	long: Blocked,
	label: string,
	context: Context,
): Promise<Parking> {
	for (const reader of readers) {
		long.blockedBy({ label, state: "loading" });
		const opened = await reader.open(context);
		if (opened.kind === "ready") continue;
		reader.source.dependents.add(wake);
		if (opened.kind === "loading") {
			const loading = new ChordError({ code: "unavailable", message: `${label} is loading` });
			return { kind: "parked", shown: LOADING, firstPass: false, cause: waitingFor(label, loading) };
		}
		long.blockedBy({ label, state: "failed" });
		const error = asChordError(opened.error, label);
		if (opened.kind === "broken") return { kind: "broken", error };
		const shown = waitingOn(label, error);
		return { kind: "parked", shown, firstPass: true, cause: shown.cause };
	}
	return READY;
}

/** One entry of `self.queries`' builders, checked: its builder, and its argument schema when it brings one. */
export type NamedBuilder = {
	readonly name: string;
	readonly builder: (args: unknown) => unknown;
	readonly args: Snapshot | undefined;
};

/**
 * The builders `self.queries` was given, checked (declaration policy: plugin code is bundled without type checks):
 * each a function (a query the contract lists) or `[argsSchema, builder]` (a private one), the schema closed.
 */
export function namedBuilders(label: string, builders: unknown): NamedBuilder[] {
	if (typeof builders !== "object" || builders === null) throw new Error(`${label}: self.queries: builders by name`);
	return Object.entries(builders).map(([name, entry]) => {
		const [schema, builder]: readonly unknown[] = Array.isArray(entry) ? entry : [undefined, entry];
		if (typeof builder !== "function") throw new Error(`${label}: self.queries: "${name}" has no builder`);
		const args = schema === undefined ? undefined : snapshotArguments(schema, `${label}: query "${name}": args`);
		// The builder is plugin code: what it returns is checked when a read opens.
		return { name, builder: builder as (args: unknown) => unknown, args };
	});
}

/** The page size `{ first: n }` of a live query or a list: a positive integer (a bound is required). */
export function firstOf(label: string, declaration: string, options: unknown): number {
	const first: unknown = (options as { readonly first?: unknown } | undefined)?.first;
	if (!Number.isSafeInteger(first) || (first as number) < 1) {
		throw new Error(`${label}: self.${declaration}: { first: n } is required, a positive integer`);
	}
	return first as number;
}

/** Checks a list's name (non-empty, once per object: its bookmarks are kept by it) and remembers it in `listed`. */
export function listName(label: string, name: unknown, listed: Set<string>): string {
	if (typeof name !== "string" || name === "") throw new Error(`${label}: self.list: a list has a name`);
	if (listed.has(name)) throw new Error(`${label}: list "${name}" is declared twice`);
	listed.add(name);
	return name;
}

/**
 * The one source `[namedQuery, args]` of a list (lists over several sources are not built yet: `slices.md`,
 * "Carry-over", slice 14).
 */
export function oneSource(label: string, sources: unknown): readonly [unknown, unknown] {
	const source: unknown = Array.isArray(sources) && sources.length === 1 ? sources[0] : undefined;
	if (!Array.isArray(source) || source.length !== 2) {
		throw new Error(`${label}: self.list: one source, [[namedQuery, args]]`);
	}
	return [source[0], source[1]];
}

/** The refusal of what `self.liveQuery`, `self.count` or `self.list` (`declaration`) was given as its named query. */
export function namedQueryExpected(label: string, declaration: string): Error {
	const hint = "a table of this object is read with self.query";
	return new Error(`${label}: self.${declaration} reads a named query; ${hint}`);
}

/** The refusal of a named query given to `self.query` as its table. */
export function tableExpected(label: string): Error {
	return new Error(`${label}: self.query reads a table of this object; a named query is read with self.liveQuery`);
}

/** The refusal of a table given to `self.query` or `self.queries` (`declaration`) that the factory did not declare. */
export function undeclaredTable(label: string, declaration: string): Error {
	return new Error(`${label}: self.${declaration}: the table is not one this factory declared`);
}

/** Where an attempt's readers live: the store and batch, the object's label, its failure reports and its wake. */
export type ReaderSite = {
	readonly site: ReadSite;
	readonly label: string;
	/** Reports a failed run of `query` after the reader went live (`query_failed`, once per episode). */
	report(query: string, error: unknown): void;
	/** Tells the attempt, waiting on a reader, to open it again. */
	wake(): void;
};

/**
 * Where the readers `label` declares on `host` live (an attempt's, an admission's): a reader needs the host's store.
 * `wake` tells whoever waits on a reader to open it again.
 */
export function readerSite(host: AnyHost, label: string, wake: () => void): ReaderSite {
	if (host.store === undefined) throw new Error(`${label}: reading a named query needs a store`);
	return {
		site: { store: host.store, batch: host.batch },
		label,
		report: (query, error) => host.report({ kind: "query_failed", object: label, query, error }),
		wake,
	};
}

/** The reader of `self.liveQuery(query, args, range)`: its value the first `range.first` rows as `{ rows, more }`. */
export function rowsReader(
	at: ReaderSite,
	query: unknown,
	args: unknown,
	range: unknown,
): { readonly reader: Reader; readonly source: LiveQuery } {
	const shape = {
		kind: "rows",
		range: { limit: firstOf(at.label, "liveQuery", range) },
		present: (rows: JsonValue[], more: boolean): JsonValue => ({ rows, more }),
	} as const;
	return liveReader(at, "liveQuery", query, args, shape);
}

/** The reader of `self.liveQuery(query, args, range)` (shape `rows`) or of `self.count(query, args)` (`count`). */
export function liveReader(
	at: ReaderSite,
	declaration: string,
	query: unknown,
	args: unknown,
	shape: LiveShape,
): { readonly reader: Reader; readonly source: LiveQuery } {
	const given = givenQuery(at, declaration, query, args);
	const source = new LiveQuery(at.site, ownerOf(at, given), shape);
	return { reader: new Reader(given, source, at.wake), source };
}

/** The reader of `self.list(name, [[query, args]], { first })`; `memory` is what the object keeps of the list. */
export function listReader(
	at: ReaderSite,
	name: string,
	source: readonly [unknown, unknown],
	first: number,
	memory: ListMemory,
): { readonly reader: Reader; readonly list: List } {
	const given = givenQuery(at, `list "${name}"`, source[0], source[1]);
	const list = new List(at.site, ownerOf(at, given), first, memory);
	return { reader: new Reader(given, list, at.wake), list };
}

/**
 * The named query a reader was given with its arguments, checked: a named query (a table of the object is the old
 * form's argument), and arguments that are JSON (their schema checks them when the read opens) or a watchable of them.
 */
function givenQuery(at: ReaderSite, declaration: string, query: unknown, args: unknown): GivenQuery {
	if (!(query instanceof NamedQueryHandle)) throw namedQueryExpected(at.label, declaration);
	const source = resolveWatchable(args);
	const given: GivenArguments =
		source === undefined ? { kind: "fixed", value: args as JsonValue } : { kind: "following", source };
	return new GivenQuery(query, given, at.site.batch);
}

/** Who a reader's source belongs to: its object, reporting failures under the query's name. */
function ownerOf(at: ReaderSite, given: GivenQuery): { readonly label: string; report(error: unknown): void } {
	return { label: at.label, report: (error) => at.report(given.handle.label, error) };
}
