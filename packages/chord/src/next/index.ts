// Chord v2 (`@earendil-works/chord/next`, experimental): every layer's API for apps, and the store's surface for
// adapters (Durable's `StoreStorage`), marked internal.

export * from "./contracts/index.ts";
export * from "./data/index.ts";
export * from "./documents/index.ts";
export * from "./host/index.ts";
export * from "./jobs/index.ts";
export * from "./link/index.ts";
export * from "./registries/index.ts";
export * from "./state/index.ts";
/** @internal The store's surface for adapters (slice 6b §2.1). */
export { type DecodedRow, OwnerTable, StoreOwnerTables } from "./store/adapter.ts";
/** @internal The sync layer's batch apply (slice 6b §1.6). */
export { applyBatch } from "./store/apply-batch.ts";
/** @internal */
export type { Claimant } from "./store/claims.ts";
/** @internal */
export {
	type DocumentAddress,
	type DocumentContent,
	type DocumentEntry,
	type DocumentHistory,
	type DocumentPoint,
	type DocumentRecord,
	type DocumentScope,
	findDocument,
	findDocumentEntry,
	insertDocument,
	listDocumentEntries,
	listDocuments,
	loadContent,
	loadDocument,
	type OwnedDocumentEntry,
	readDocument,
	readDocumentEntry,
	retireRecord,
	type StoredDocument,
	writeContent,
} from "./store/engine.ts";
/** @internal */
export type { WhereNode } from "./store/expression.ts";
export * from "./store/index.ts";
/** @internal */
export type { EncodedRow } from "./store/rows.ts";
/** @internal */
export type { Order } from "./store/sql.ts";
/** @internal */
export type { StagedWrite, Step } from "./store/step.ts";
/** @internal */
export type { ChordStore } from "./store/store.ts";
