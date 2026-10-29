// One Durable commit as one composite write of the store's commit step (slice 6b §2.3): staged before the queue (rows
// encoded, contents serialized, explicit ids raising the store's allocator, fork copies resolved from their sources),
// then inside the step what `SqliteStorage` does inside its transaction, with the step's reader: Durable's checks of
// ids and documents (its messages), the table puts, and the documents in two passes, existing ones first (their content,
// then their retirement, which frees the addresses this commit's creations take), then the creations and copies.

import type { Context, JsonValue } from "@earendil-works/chord";
import {
	type EncodedRow,
	type DocumentContent as EngineContent,
	type DocumentRecord as EngineRecord,
	findDocument,
	insertDocument,
	type OwnerTable,
	readDocument,
	retireRecord,
	type StagedWrite,
	type Step,
	type StoreWrite,
	writeContent,
} from "@earendil-works/chord/next";
import type {
	DocumentContent,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	Id,
	JsonObject,
	StorageWrite,
} from "../../types.ts";
import { addressOf, durableRecord, engineRecord } from "./documents.ts";
import { conversationRow, entryRow, submissionRow, taskRow } from "./tables.ts";

/** Durable's record types, as `record_ids` names them. */
export type RecordType = "conversation" | "entry" | "task" | "submission" | "document";

/** The storage's tables, as a commit writes them. */
export type CommitTables = {
	readonly recordIds: OwnerTable;
	readonly conversations: OwnerTable;
	readonly entries: OwnerTable;
	readonly entryHeads: OwnerTable;
	readonly tasks: OwnerTable;
	readonly submissions: OwnerTable;
};

/** A table write of the commit: its record's id and type, its table and its row encoded at staging. */
type RowWrite = {
	readonly id: number;
	readonly type: Exclude<RecordType, "document">;
	readonly table: OwnerTable;
	readonly row: EncodedRow;
};

/** A base as the commit stores it: its version and value, and the value serialized. */
type StagedBase = { readonly version: number; readonly value: JsonObject; readonly text: string };

/** What one commit does with one document, as `SqliteStorage`'s action map has it. */
type DocumentAction = {
	create?: DocumentCreate;
	copy?: DocumentCopySource;
	/** A creation's base: the write's own, or a copy's once resolved. */
	base?: StagedBase;
	content?: { readonly content: DocumentContent; readonly text: string };
	retire: boolean;
};

/** Reads a copy's source at its point: its stored document, `undefined` when it cannot be read there. */
export type CopySource = (
	source: DocumentCopySource,
) => Promise<{ readonly record: DocumentRecord; readonly version: number; readonly value: JsonObject } | undefined>;

/** A Durable commit staged for the store's step. */
export class DurableCommit implements StagedWrite {
	readonly order = "write";
	readonly #owner: string;
	readonly #tables: CommitTables;
	readonly #context: Context;
	/** Every id a write claims, in write order (documents created or copied included), for the id checks. */
	readonly #claims: { readonly id: number; readonly type: RecordType }[] = [];
	readonly #rows: RowWrite[] = [];
	readonly #actions = new Map<DocumentId, DocumentAction>();

	/**
	 * Stages `writes` (rule 8: rows and contents encoded here, before the queue); `raise` makes room above each explicit
	 * id. A malformed batch (two content commands for one document, a second retirement) throws Durable's message.
	 */
	constructor(
		writes: readonly StorageWrite[],
		owner: string,
		tables: CommitTables,
		raise: (id: number) => void,
		context: Context,
	) {
		this.#owner = owner;
		this.#tables = tables;
		this.#context = context;
		for (const write of writes) this.#stage(write, raise);
	}

	/**
	 * Resolves the copies before the step (S11): each source read at its point and checked against the copy's record,
	 * entered as a creation carrying the source's value as its base.
	 */
	async resolveCopies(read: CopySource): Promise<void> {
		for (const [id, action] of this.#actions) {
			const source = action.copy;
			if (source === undefined) continue;
			if (this.#actions.has(source.id)) throw new Error(`Document copy ${id} source is changed in the copy batch`);
			try {
				const stored = await read(source);
				if (stored === undefined) throw new Error(`Fork source document ${source.id} cannot be read`);
				const create = action.create!;
				if (
					stored.record.scope.kind !== "conversation" ||
					create.scope.kind !== "conversation" ||
					stored.record.kind !== create.kind ||
					stored.record.key !== create.key ||
					stored.record.history !== create.history ||
					stored.record.fork !== create.fork
				) {
					throw new Error(`Fork source document ${source.id} does not match the copied record`);
				}
				action.base = { version: stored.version, value: stored.value, text: JSON.stringify(stored.value) };
			} catch (error) {
				throw new Error(`Document copy ${id} was rejected`, { cause: error });
			}
		}
	}

	async apply(step: Step): Promise<readonly StoreWrite[]> {
		const recorded: StoreWrite[] = [];
		const claimed = await this.#checkIds(step);
		const existing = await this.#checkDocuments(step);
		for (const write of this.#rows) {
			if (claimed.get(write.id) === undefined) recorded.push(await this.#claim(step, write.id, write.type));
			claimed.set(write.id, write.type);
			const stamp = write.table === this.#tables.entries ? "commit_seq" : undefined;
			recorded.push(await write.table.put(step, write.row, stamp));
		}
		// Existing documents first: a retirement frees its address before a creation of this commit takes it.
		for (const [id, record] of existing) recorded.push(...(await this.#change(step, record, this.#actions.get(id)!)));
		for (const [id, action] of this.#actions) {
			if (action.create === undefined) continue;
			recorded.push(await this.#claim(step, id, "document"));
			recorded.push(await this.#create(step, action.create, action.base!, action.retire));
		}
		return recorded;
	}

	/** Stages one write: a table row encoded, a document command into its action. */
	#stage(write: StorageWrite, raise: (id: number) => void): void {
		const tables = this.#tables;
		switch (write.type) {
			case "conversation":
				this.#row(write.value.id, write.type, tables.conversations, conversationRow(write.value), raise);
				return;
			case "entry": {
				const { id, conversationId, head } = write.value;
				this.#row(id, write.type, tables.entries, entryRow(write.value), raise);
				// Its claim is the entry's: `apply` claims an id once.
				if (head !== undefined) {
					const row = tables.entryHeads.encode({ id, conversation_id: conversationId });
					this.#rows.push({ id, type: write.type, table: tables.entryHeads, row });
				}
				return;
			}
			case "task":
				this.#row(write.value.id, write.type, tables.tasks, taskRow(write.value), raise);
				return;
			case "submission":
				this.#row(write.value.id, write.type, tables.submissions, submissionRow(write.value), raise);
				return;
			case "document.create":
			case "document.copy": {
				const { id } = write.record;
				const action = this.#action(id);
				if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${id} has more than one content command`);
				}
				action.create = write.record;
				if (write.type === "document.copy") action.copy = write.source;
				else action.base = { ...write.content, text: JSON.stringify(write.content.value) };
				this.#claims.push({ id, type: "document" });
				raise(id);
				return;
			}
			case "document.change": {
				const action = this.#action(write.id);
				// A creation's base is its content command (`SqliteStorage` counts it so too), in either order.
				if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${write.id} has more than one content command`);
				}
				const { content } = write;
				action.content = { content, text: JSON.stringify(content.kind === "base" ? content.value : content.ops) };
				return;
			}
			case "document.retire": {
				const action = this.#action(write.id);
				if (action.retire) throw new Error(`Document ${write.id} is retired more than once`);
				action.retire = true;
				return;
			}
		}
	}

	#row(id: Id<string>, type: RowWrite["type"], table: OwnerTable, row: object, raise: (id: number) => void): void {
		this.#claims.push({ id, type });
		this.#rows.push({ id, type, table, row: table.encode(row) });
		raise(id);
	}

	#action(id: DocumentId): DocumentAction {
		let action = this.#actions.get(id);
		if (action === undefined) {
			action = { retire: false };
			this.#actions.set(id, action);
		}
		return action;
	}

	/**
	 * Durable's global id checks (`SqliteStorage.checkGlobalIds`): a conversation, entry or document id claimed by
	 * anything, or written twice; a task or submission id claimed by another type. Returns the stored types.
	 */
	async #checkIds(step: Step): Promise<Map<number, RecordType>> {
		const stored = new Map<number, RecordType | undefined>();
		const claimed = new Map<number, RecordType>();
		for (const { id, type } of this.#claims) {
			let existing = stored.get(id);
			if (!stored.has(id)) {
				const row = await this.#tables.recordIds.get(step, [id], this.#context);
				existing = row?.record_type as RecordType | undefined;
				stored.set(id, existing);
			}
			const earlier = claimed.get(id);
			if (type === "conversation" || type === "entry" || type === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== type) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== type) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, type);
		}
		const types = new Map<number, RecordType>();
		for (const [id, type] of stored) if (type !== undefined) types.set(id, type);
		return types;
	}

	/**
	 * Durable's document checks (`SqliteStorage.checkDocumentActions`): a change or retirement of an unknown or retired
	 * document, a delta on another version, more than one live incarnation per address after the commit. Returns the
	 * existing records the commit changes or retires, in action order.
	 */
	async #checkDocuments(step: Step): Promise<Map<DocumentId, EngineRecord>> {
		const existing = new Map<DocumentId, EngineRecord>();
		for (const [id, action] of this.#actions) {
			if (action.create !== undefined) continue;
			const stored = await readDocument(step, id);
			const record = stored === undefined ? undefined : durableRecord(stored, this.#owner);
			if (record === undefined) throw new Error(`Unknown document: ${id}`);
			if (record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			const content = action.content?.content;
			if (content?.kind === "delta" && content.version !== stored!.version) {
				throw new Error(`Document ${id} version transition requires a base`);
			}
			existing.set(id, stored!);
		}
		/** Per address a live creation takes: its live incarnations after the commit so far. */
		const live = new Map<string, number>();
		for (const action of this.#actions.values()) {
			if (action.create === undefined || action.retire) continue;
			const address = addressOf(action.create, this.#owner);
			const key = JSON.stringify([address.namespace, address.kind, address.key]);
			let count = live.get(key);
			if (count === undefined) {
				// The incarnation live there now counts unless this commit retires it.
				const current = await findDocument(step, address);
				count = current === undefined || this.#actions.get(current.id as DocumentId)?.retire === true ? 0 : 1;
			}
			if (++count > 1) throw new Error("Document address already has a current incarnation");
			live.set(key, count);
		}
		return existing;
	}

	/** Puts `id`'s `record_ids` row: its record type. */
	#claim(step: Step, id: number, type: RecordType): Promise<StoreWrite> {
		const table = this.#tables.recordIds;
		return table.put(step, table.encode({ id, record_type: type }));
	}

	/** An existing document's content, then its retirement, as their writes. */
	async #change(step: Step, record: EngineRecord, action: DocumentAction): Promise<StoreWrite[]> {
		const writes: StoreWrite[] = [];
		let { revision } = record;
		if (action.content !== undefined) {
			const { content, text } = action.content;
			const stored = engineContent(content);
			await writeContent(step, record.id, record.history, revision, stored, text);
			writes.push({ kind: "document.change", id: record.id, revision, content: stored });
			revision++;
		}
		if (action.retire) {
			await retireRecord(step, record);
			writes.push({ kind: "document.retire", id: record.id, revision });
		}
		return writes;
	}

	/** A creation or a resolved copy (retired at once for a create-plus-retire, an empty lifetime), as its write. */
	async #create(step: Step, create: DocumentCreate, base: StagedBase, retired: boolean): Promise<StoreWrite> {
		const record = engineRecord(create, this.#owner, base.version, step.seq, retired);
		await insertDocument(step, record, base.text);
		const value = base.value as JsonValue;
		return { kind: "document.create", record, base: { version: base.version, fingerprint: "", value } };
	}
}

/** A Durable content as the engine stores it: its documents have no schema fingerprint. */
function engineContent(content: DocumentContent): EngineContent {
	return content.kind === "base"
		? { kind: "base", version: content.version, fingerprint: "", value: content.value }
		: { kind: "delta", version: content.version, ops: content.ops };
}
