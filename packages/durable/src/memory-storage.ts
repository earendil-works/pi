import type { Context, JsonValue } from "@earendil-works/chord";
import type {
	ConversationRecord,
	Cursor,
	EntryQuery,
	EntryRecord,
	Id,
	Input,
	Page,
	Seq,
	Storage,
	StorageWrite,
	TaskQuery,
	TaskRecord,
} from "./types.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TaskStatus = StoredTask["state"]["status"];
type TableName = "conversation" | "entry" | "task" | "input";

type State = {
	conversations: Map<Id, ConversationRecord>;
	conversationIds: Id[];
	entries: Map<Id, EntryRecord>;
	entryIds: Map<Id, Id[]>;
	headEntryIds: Map<Id, Id[]>;
	entryCommitSeqs: Map<Id, Seq>;
	tasks: Map<Id, StoredTask>;
	taskIds: Id[];
	taskIdsByStatus: Record<TaskStatus, Id[]>;
	inputs: Map<Id, Input>;
	inputIdsByRequest: Map<Id, Map<string, Id>>;
};

const clone = <T>(value: T): T => {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
	const source = value as Record<string, unknown>;
	const nullPrototype = Object.getPrototypeOf(value) === null;
	const result = (nullPrototype ? Object.create(null) : {}) as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		const copied = clone(source[key]);
		if (!nullPrototype && key in result) {
			Object.defineProperty(result, key, {
				value: copied,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			result[key] = copied;
		}
	}
	return result as T;
};

const cursorId = (cursor: Readonly<Record<string, JsonValue>> | undefined): Id | undefined =>
	cursor?.after as Id | undefined;

const lowerBound = (ids: readonly Id[], target: Id): number => {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ids[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
};

const upperBound = (ids: readonly Id[], target: Id): number => {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ids[middle] <= target) low = middle + 1;
		else high = middle;
	}
	return low;
};

const insertSorted = (ids: Id[], id: Id): void => {
	if (ids.length === 0 || ids[ids.length - 1] < id) ids.push(id);
	else ids.splice(lowerBound(ids, id), 0, id);
};

const removeSorted = (ids: Id[], id: Id): void => {
	const index = lowerBound(ids, id);
	if (ids[index] === id) ids.splice(index, 1);
};

const tableContaining = (state: State, id: Id): TableName | undefined => {
	if (state.conversations.has(id)) return "conversation";
	if (state.entries.has(id)) return "entry";
	if (state.tasks.has(id)) return "task";
	if (state.inputs.has(id)) return "input";
	return undefined;
};

const page = <T extends { readonly id: Id }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items: clone(items) };
	return { items: clone(items), next: { after: items.at(-1)!.id } };
};

/**
 * Detached in-memory reference implementation of `Storage`.
 *
 * Reads and retained writes are cloned intentionally to match the ownership boundary
 * of serialization-backed stores. This is backend conformance, not validation.
 */
export class MemoryStorage implements Storage {
	private readonly state: State = {
		conversations: new Map(),
		conversationIds: [],
		entries: new Map(),
		entryIds: new Map(),
		headEntryIds: new Map(),
		entryCommitSeqs: new Map(),
		tasks: new Map(),
		taskIds: [],
		taskIdsByStatus: { pending: [], running: [], terminal: [] },
		inputs: new Map(),
		inputIdsByRequest: new Map(),
	};
	private nextId = 2;
	private nextSeq = 1;
	private closed = false;

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const prepared = writes.map((write) => clone(write));
		this.checkImmutableIds(prepared);
		const seq = this.nextSeq;

		for (const write of prepared) {
			switch (write.type) {
				case "conversation":
					this.state.conversations.set(write.value.id, write.value);
					insertSorted(this.state.conversationIds, write.value.id);
					break;
				case "entry": {
					this.state.entries.set(write.value.id, write.value);
					this.state.entryCommitSeqs.set(write.value.id, seq);
					let ids = this.state.entryIds.get(write.value.conversationId);
					if (ids === undefined) {
						ids = [];
						this.state.entryIds.set(write.value.conversationId, ids);
					}
					insertSorted(ids, write.value.id);
					if (write.value.head !== undefined) {
						let headIds = this.state.headEntryIds.get(write.value.conversationId);
						if (headIds === undefined) {
							headIds = [];
							this.state.headEntryIds.set(write.value.conversationId, headIds);
						}
						insertSorted(headIds, write.value.id);
					}
					break;
				}
				case "task": {
					const previous = this.state.tasks.get(write.value.id);
					if (previous === undefined) {
						insertSorted(this.state.taskIds, write.value.id);
						insertSorted(this.state.taskIdsByStatus[write.value.state.status], write.value.id);
					} else if (previous.state.status !== write.value.state.status) {
						removeSorted(this.state.taskIdsByStatus[previous.state.status], write.value.id);
						insertSorted(this.state.taskIdsByStatus[write.value.state.status], write.value.id);
					}
					this.state.tasks.set(write.value.id, write.value);
					break;
				}
				case "input": {
					const previous = this.state.inputs.get(write.value.id);
					if (previous?.requestId !== undefined) {
						const previousRequests = this.state.inputIdsByRequest.get(previous.conversationId);
						if (previousRequests?.get(previous.requestId) === write.value.id) {
							previousRequests.delete(previous.requestId);
							if (previousRequests.size === 0) this.state.inputIdsByRequest.delete(previous.conversationId);
						}
					}
					this.state.inputs.set(write.value.id, write.value);
					if (write.value.requestId !== undefined) {
						let requests = this.state.inputIdsByRequest.get(write.value.conversationId);
						if (requests === undefined) {
							requests = new Map();
							this.state.inputIdsByRequest.set(write.value.conversationId, requests);
						}
						requests.set(write.value.requestId, write.value.id);
					}
					break;
				}
			}
			this.nextId = Math.max(this.nextId, write.value.id + 1);
		}
		this.nextSeq++;
		return seq;
	}

	mintId(): Id {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++;
	}

	async conversation(id: Id, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const value = this.state.conversations.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanConversations(
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const start = after === undefined ? 0 : upperBound(this.state.conversationIds, after);
		const values = this.state.conversationIds
			.slice(start, start + limit + 1)
			.map((id) => this.state.conversations.get(id)!);
		return page(values, limit);
	}

	async entry(
		id: Id,
		_context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		this.assertOpen();
		const entry = this.state.entries.get(id);
		if (entry === undefined) return undefined;
		return { entry: clone(entry), commitSeq: this.state.entryCommitSeqs.get(id)! };
	}

	async findLatestHeadMarker(
		conversationId: Id,
		atOrBeforeEntryId: Id | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: Id }) | undefined> {
		this.assertOpen();
		if (!this.state.conversations.has(conversationId)) {
			throw new Error(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		let upperEntryId = atOrBeforeEntryId ?? Number.POSITIVE_INFINITY;
		while (true) {
			const ids = this.state.headEntryIds.get(currentId) ?? [];
			const index = upperBound(ids, upperEntryId) - 1;
			if (index >= 0) {
				const entry = this.state.entries.get(ids[index])!;
				return clone({ ...entry, head: entry.head! });
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) return undefined;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			currentId = conversation.parent.conversationId;
		}
	}

	async scanEntries(
		query: EntryQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const maxEntryId =
			after === undefined ? query.maxEntryId : Math.min(query.maxEntryId ?? Number.POSITIVE_INFINITY, after - 1);
		const visible: EntryRecord[] = [];
		for (const entry of this.visibleEntries(query.conversationId, query.minEntryId, maxEntryId)) {
			visible.push(entry);
			if (visible.length > limit) break;
		}
		return page(visible, limit);
	}

	async task(id: Id, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const value = this.state.tasks.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanTasks(
		query: TaskQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const ids = query.status === undefined ? this.state.taskIds : this.state.taskIdsByStatus[query.status];
		const start = after === undefined ? 0 : upperBound(ids, after);
		const values: StoredTask[] = [];
		for (let index = start; index < ids.length && values.length <= limit; index++) {
			const value = this.state.tasks.get(ids[index])!;
			if (query.conversationId !== undefined && value.conversationId !== query.conversationId) continue;
			if (query.kind !== undefined && value.kind !== query.kind) continue;
			if (query.abortRequested !== undefined && value.abortRequested !== query.abortRequested) continue;
			if (query.background !== undefined && value.background !== query.background) continue;
			values.push(value);
		}
		return page(values, limit);
	}

	async input(id: Id, _context: Context): Promise<Input | undefined> {
		this.assertOpen();
		const value = this.state.inputs.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async inputByRequest(conversationId: Id, requestId: string, _context: Context): Promise<Input | undefined> {
		this.assertOpen();
		const id = this.state.inputIdsByRequest.get(conversationId)?.get(requestId);
		if (id === undefined) return undefined;
		return clone(this.state.inputs.get(id)!);
	}

	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	private *visibleEntries(
		conversationId: Id,
		minEntryId = Number.NEGATIVE_INFINITY,
		maxEntryId = Number.POSITIVE_INFINITY,
	): Generator<EntryRecord> {
		if (!this.state.conversations.has(conversationId)) {
			throw new Error(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		let upperEntryId = maxEntryId;
		while (true) {
			const ids = this.state.entryIds.get(currentId) ?? [];
			for (let index = upperBound(ids, upperEntryId) - 1; index >= 0; index--) {
				const id = ids[index];
				if (id < minEntryId) break;
				yield this.state.entries.get(id)!;
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) break;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			if (upperEntryId < minEntryId) break;
			currentId = conversation.parent.conversationId;
		}
	}

	private checkImmutableIds(writes: readonly StorageWrite[]): void {
		const claimed = new Map<Id, TableName>();
		for (const write of writes) {
			const table = write.type;
			const id = write.value.id;
			const existing = tableContaining(this.state, id);
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) {
					throw new Error(`ID ${id} already belongs to ${existing}`);
				}
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemoryStorage is closed");
	}
}
