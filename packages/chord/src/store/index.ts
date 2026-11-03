// The store for apps: opening it over a backend, tables with their queries, writes and migrations, export and
// import of archives (with their JSONL encoding), the outbox, text order.

export type { ArchiveManifest, ArchivePart } from "./archive.ts";
export { type Backend, sqliteBackend } from "./backend.ts";
export type { Columns, PutRowOf, RowOf } from "./columns.ts";
export {
	add,
	and,
	type ColumnRef,
	type Condition,
	coalesce,
	concat,
	type Expression,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	max,
	min,
	ne,
	not,
	or,
	prefix,
	replacePrefix,
	type SetOf,
	sub,
	when,
} from "./expression.ts";
export { importStore } from "./import.ts";
export { type JsonColumnOptions, type JsonColumnSchema, json } from "./json-column.ts";
export { decodeJsonl, encodeJsonl } from "./jsonl.ts";
export type { Outbox, OutboxCommit } from "./outbox.ts";
export { type ColumnRefs, type Query, query } from "./query.ts";
export { openStore, type Store, type StoreOptions } from "./store.ts";
export { defineTable, type KeyOf, type TableDefinition, type TableOptions } from "./table.ts";
export {
	type AddedColumn,
	evolveTable,
	type PatchOf,
	type TableEditor,
	type TableTailEditor,
} from "./table-evolve.ts";
export type { Page, PageOptions, Table, TableOf } from "./table-handle.ts";
export { compareText } from "./text.ts";
export type { StoreWrite } from "./writes.ts";
