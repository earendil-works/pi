// The store for apps: opening it over a backend, tables with their queries, writes and migrations, export and
// import of archives (with their JSONL encoding), a host's data (export, import, delete), the outbox, text order.

export type { ArchiveManifest, ArchivePart } from "./archive.ts";
export { type Backend, sqliteBackend } from "./backend.ts";
export { type ColumnSet, type ColumnSetOptions, defineColumns } from "./column-set.ts";
export type { Columns, PutRowOf, RowOf } from "./columns.ts";
export {
	add,
	and,
	type ColumnRef,
	type Condition,
	coalesce,
	compile,
	concat,
	type Expression,
	eq,
	exists,
	existsNode,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	type Match,
	max,
	min,
	ne,
	not,
	or,
	prefix,
	replacePrefix,
	type SetOf,
	sub,
	type WhereNode,
	when,
} from "./expression.ts";
export { type HostColumnSchema, host } from "./host-column.ts";
export {
	exportHostData,
	type HostArchive,
	type HostDataCounts,
	type HostImportOptions,
	readHostArchive,
} from "./host-data.ts";
export { importStore } from "./import.ts";
export { type JsonColumnOptions, type JsonColumnSchema, json } from "./json-column.ts";
export { decodeJsonl, encodeJsonl } from "./jsonl.ts";
export type { Outbox, OutboxCommit } from "./outbox.ts";
export { type ColumnRefs, type Query, query } from "./query.ts";
export { openStore, type Store, type StoreOptions } from "./store.ts";
export { defineTable, type KeyOf, type TableDefinition, type TableOptions } from "./table.ts";
export {
	type AddedColumn,
	type EvolveOptions,
	evolveTable,
	type PatchOf,
	type TableEditor,
	type TableTailEditor,
} from "./table-evolve.ts";
export type { Page, PageOptions, Table, TableOf } from "./table-handle.ts";
export { compareText } from "./text.ts";
export type { StoreWrite } from "./writes.ts";
