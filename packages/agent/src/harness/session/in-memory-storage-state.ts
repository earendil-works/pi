import { addUsage, emptyUsage } from "../utils/usage.ts";
import { type CommittedWrite, type PreparedCommit, prepareStorageCommit, validateCommittedWrites } from "./commit.ts";

export type {
	CommittedEntryWrite,
	CommittedListAppendWrite,
	CommittedListDeleteWrite,
	CommittedUsageWrite,
	CommittedValueDeleteWrite,
	CommittedValueSetWrite,
	CommittedWrite,
	PreparedCommit,
} from "./commit.ts";

import type {
	Entry,
	EntryScan,
	EntryStructure,
	SessionStats,
	StorageBranchScan,
	UsageRow,
	UsageScan,
	Write,
} from "./types.ts";
import {
	type ListElement,
	type ListReadOptions,
	list,
	resolveListReadOptions,
	type StoredValue,
	type Value,
	type ValueList,
	value,
} from "./values.ts";

interface StoredListSnapshot {
	address: ValueList<unknown>;
	elements: ListElement<unknown>[];
}

function physicalKey(namespace: string, key: string): string {
	return `${namespace}\u0000${key}`;
}

function compareKeys(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0)!);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0)!);
	const length = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < length; index++) {
		const difference = leftCodePoints[index]! - rightCodePoints[index]!;
		if (difference !== 0) return difference;
	}
	return leftCodePoints.length - rightCodePoints.length;
}

/**
 * Complete materialized session state for MemoryStorage and JsonlStorage.
 *
 * This is intentionally unsuitable for database backends and long-running sessions that may not fit in memory.
 * Those backends should query indexed durable state and update durable aggregates within each commit transaction.
 */
export class InMemoryStorageState {
	private readonly entries: Map<string, Entry>;
	private readonly entriesBySeq: Entry[];
	private readonly scalarValues: Map<string, StoredValue<unknown>>;
	private readonly listValues: Map<string, StoredListSnapshot>;
	private readonly usage: Map<string, UsageRow>;
	private stats: SessionStats;
	private nextSeq: number;

	constructor() {
		this.entries = new Map();
		this.entriesBySeq = [];
		this.scalarValues = new Map();
		this.listValues = new Map();
		this.usage = new Map();
		this.stats = { messageCount: 0, usage: emptyUsage() };
		this.nextSeq = 1;
	}

	prepareCommit(writes: Write[], timestamp: number): PreparedCommit {
		const prepared = prepareStorageCommit(writes, this.nextSeq, timestamp);
		this.validateCommitted(prepared.writes);
		return prepared;
	}

	validateCommitted(writes: readonly CommittedWrite[]): void {
		validateCommittedWrites(writes, this.nextSeq, {
			hasEntryOrUsageId: (id) => this.entries.has(id) || this.usage.has(id),
			hasEntryId: (id) => this.entries.has(id),
		});
	}

	/** Apply writes already accepted by validateCommitted() and return the post-apply totals. */
	applyValidated(writes: readonly CommittedWrite[]): SessionStats {
		for (const write of writes) {
			switch (write.kind) {
				case "entry": {
					const { kind: _kind, ...entry } = write;
					this.entries.set(entry.id, entry);
					this.entriesBySeq.push(entry);
					if (entry.type === "message") this.stats = { ...this.stats, messageCount: this.stats.messageCount + 1 };
					break;
				}
				case "usage": {
					const { kind: _kind, ...row } = write;
					this.usage.set(row.id, row);
					this.stats = { ...this.stats, usage: addUsage(this.stats.usage, row.usage) };
					break;
				}
				case "value": {
					const key = physicalKey(write.namespace, write.key);
					if (write.op === "delete") {
						this.scalarValues.delete(key);
					} else {
						this.scalarValues.set(key, {
							address: value<unknown>(write.namespace, write.key),
							value: write.value,
							seq: write.seq,
						});
					}
					break;
				}
				case "list": {
					const key = physicalKey(write.namespace, write.key);
					if (write.op === "delete") {
						this.listValues.delete(key);
					} else {
						const stored = this.listValues.get(key);
						const element = { seq: write.seq, value: write.value };
						if (stored === undefined) {
							this.listValues.set(key, {
								address: list<unknown>(write.namespace, write.key),
								elements: [element],
							});
						} else {
							stored.elements.push(element);
						}
					}
					break;
				}
			}
			this.nextSeq = write.seq + 1;
		}
		return this.stats;
	}

	advanceNextSeq(nextSeq: number): void {
		if (!Number.isSafeInteger(nextSeq) || nextSeq < 1) {
			throw new Error(`Invalid storage sequence high-water mark: ${nextSeq}`);
		}
		this.nextSeq = Math.max(this.nextSeq, nextSeq);
	}

	getEntries(ids: readonly string[]): Map<string, Entry> {
		const found = new Map<string, Entry>();
		for (const id of ids) {
			const entry = this.entries.get(id);
			if (entry !== undefined) found.set(id, entry);
		}
		return found;
	}

	getValue<T>(address: Value<T>): StoredValue<T> | undefined {
		return this.scalarValues.get(physicalKey(address.namespace, address.key)) as StoredValue<T> | undefined;
	}

	scanValues<T>(prefix: Value<T>): StoredValue<T>[] {
		return [...this.scalarValues.values()]
			.filter((stored) => stored.address.namespace === prefix.namespace && stored.address.key.startsWith(prefix.key))
			.sort((left, right) => compareKeys(left.address.key, right.address.key)) as StoredValue<T>[];
	}

	readList<T>(address: ValueList<T>, options?: ListReadOptions): ListElement<T>[] {
		const resolved = resolveListReadOptions(options);
		const elements = this.listValues.get(physicalKey(address.namespace, address.key))?.elements ?? [];
		const filtered = elements.filter((element) => {
			if (resolved.cursor === undefined) return true;
			return resolved.order === "asc" ? element.seq > resolved.cursor.seq : element.seq < resolved.cursor.seq;
		});
		const ordered = resolved.order === "asc" ? filtered : [...filtered].reverse();
		return ordered.slice(0, resolved.limit) as ListElement<T>[];
	}

	scanBranch(query: StorageBranchScan): Entry[] {
		const start = this.entries.get(query.start);
		if (start === undefined) throw new Error(`Unknown branch start: ${query.start}`);

		const path: Entry[] = [];
		let entry: Entry | undefined = start;
		while (entry !== undefined) {
			path.push(entry);
			if (entry.parentId === null) break;
			entry = this.entries.get(entry.parentId);
			if (entry === undefined) throw new Error("Corrupt branch: missing parent");
		}
		if (query.order === "oldestFirst") path.reverse();

		const stopped: Entry[] = [];
		for (const candidate of path) {
			stopped.push(candidate);
			if (candidate.id === query.stopAtId || candidate.type === query.stopAtType) break;
		}
		const filtered = stopped
			.filter((candidate) => query.type === undefined || candidate.type === query.type)
			.filter((candidate) => query.customType === undefined || candidate.customType === query.customType)
			.filter(
				(candidate) =>
					query.cursor === undefined ||
					(query.order === "oldestFirst" ? candidate.seq > query.cursor.seq : candidate.seq < query.cursor.seq),
			);
		return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
	}

	scanBranchStructure(query: StorageBranchScan): EntryStructure[] {
		return this.scanBranch(query).map((entry) => ({
			id: entry.id,
			parentId: entry.parentId,
			seq: entry.seq,
			timestamp: entry.timestamp,
			type: entry.type,
			...(entry.customType === undefined ? {} : { customType: entry.customType }),
		}));
	}

	scanEntries(query: EntryScan): Entry[] {
		const limit = query.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(query.limit));
		const entries: Entry[] = [];
		const descending = query.order === "desc";
		let index = descending ? this.entriesBySeq.length - 1 : 0;
		while (index >= 0 && index < this.entriesBySeq.length && entries.length < limit) {
			const entry = this.entriesBySeq[index]!;
			if (
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || entry.customType === query.customType) &&
				(query.fromSeq === undefined || entry.seq >= query.fromSeq) &&
				(query.toSeq === undefined || entry.seq <= query.toSeq)
			) {
				entries.push(entry);
			}
			index += descending ? -1 : 1;
		}
		return entries;
	}

	scanUsage(query: UsageScan): UsageRow[] {
		const rows = [...this.usage.values()]
			.filter((row) => query.fromSeq === undefined || row.seq >= query.fromSeq)
			.filter((row) => query.toSeq === undefined || row.seq <= query.toSeq)
			.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
		return query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit));
	}

	getStats(): SessionStats {
		return this.stats;
	}

	snapshotEntriesAndValues(): { entries: Entry[]; scalarValues: StoredValue<unknown>[] } {
		return {
			entries: [...this.entries.values()].sort((left, right) => left.seq - right.seq),
			scalarValues: [...this.scalarValues.values()],
		};
	}
}
