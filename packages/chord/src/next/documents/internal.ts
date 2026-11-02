// Documents for Chord's layers: an object's documents and slots, the handles' classes, the seal token, transactions.

export { AddressSource } from "./address-source.ts";
export { Documents, type DocumentsOwner } from "./documents.ts";
export { SealToken } from "./fence.ts";
export { type KeyDeclarer, Keyed, Singleton } from "./handles.ts";
export { type KeyedSlot, KeySource } from "./keyed-slot.ts";
export {
	type DocumentChange,
	type Held,
	Persistence,
	type Stored,
	type StoredChange,
	storedAfter,
} from "./persistence.ts";
export { type AnyDefinition, type DocumentSlot, type PersistedSlot, SlotDefinition } from "./slot.ts";
export type { Staged, Transaction } from "./transaction.ts";
