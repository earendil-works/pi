import type { CommitResult, Entry, EntryWrite, NewEntry, UsageRow, UsageWrite, Write } from "./types.ts";

export type CommittedEntryWrite = Entry & { kind: "entry" };
export type CommittedUsageWrite = UsageRow & { kind: "usage" };
export interface CommittedValueSetWrite {
	kind: "value";
	op: "set";
	seq: number;
	namespace: string;
	key: string;
	value: unknown;
}
export interface CommittedValueDeleteWrite {
	kind: "value";
	op: "delete";
	seq: number;
	namespace: string;
	key: string;
}
export interface CommittedListAppendWrite {
	kind: "list";
	op: "append";
	seq: number;
	namespace: string;
	key: string;
	value: unknown;
}
export interface CommittedListDeleteWrite {
	kind: "list";
	op: "delete";
	seq: number;
	namespace: string;
	key: string;
}
export type CommittedWrite =
	| CommittedEntryWrite
	| CommittedUsageWrite
	| CommittedValueSetWrite
	| CommittedValueDeleteWrite
	| CommittedListAppendWrite
	| CommittedListDeleteWrite;

export interface PreparedCommit {
	writes: CommittedWrite[];
	result: Omit<CommitResult, "stats">;
}

export interface CommitValidationState {
	hasEntryOrUsageId(id: string): boolean;
	hasEntryId(id: string): boolean;
}

export function insertEntry(entry: NewEntry): EntryWrite {
	return { kind: "entry", entry };
}

export function insertUsage(row: Omit<UsageRow, "seq">): UsageWrite {
	return { kind: "usage", row };
}

export function commitWrite(write: Write, seq: number, timestamp: number): CommittedWrite {
	switch (write.kind) {
		case "entry":
			return { kind: "entry", ...write.entry, seq, timestamp };
		case "usage":
			return { kind: "usage", ...write.row, seq };
		case "value":
			return write.op === "set"
				? { kind: "value", op: "set", seq, namespace: write.namespace, key: write.key, value: write.value }
				: { kind: "value", op: "delete", seq, namespace: write.namespace, key: write.key };
		case "list":
			return write.op === "append"
				? { kind: "list", op: "append", seq, namespace: write.namespace, key: write.key, value: write.value }
				: { kind: "list", op: "delete", seq, namespace: write.namespace, key: write.key };
	}
}

export function materializeCommittedEntry(entry: NewEntry, seq: number, timestamp: number): Entry {
	return { ...entry, seq, timestamp };
}

export function prepareStorageCommit(writes: Write[], firstSeq: number, timestamp: number): PreparedCommit {
	const committedWrites = writes.map((write, index) => commitWrite(write, firstSeq + index, timestamp));
	return {
		writes: committedWrites,
		result: { firstSeq, seqs: committedWrites.map((write) => write.seq), timestamp },
	};
}

export function validateCommittedWrites(
	writes: readonly CommittedWrite[],
	firstSeq: number,
	state: CommitValidationState,
): void {
	let previousSeq = firstSeq - 1;
	const transactionIds = new Set<string>();
	const transactionEntryIds = new Set<string>();
	for (const write of writes) {
		if (write.seq <= previousSeq) throw new Error(`Non-monotonic storage sequence: ${write.seq}`);
		previousSeq = write.seq;
		if (write.kind !== "entry" && write.kind !== "usage") continue;
		if (state.hasEntryOrUsageId(write.id) || transactionIds.has(write.id)) {
			throw new Error(`Duplicate entry or usage id: ${write.id}`);
		}
		if (
			write.kind === "entry" &&
			write.parentId !== null &&
			!state.hasEntryId(write.parentId) &&
			!transactionEntryIds.has(write.parentId)
		) {
			throw new Error(`Missing parent entry: ${write.parentId}`);
		}
		transactionIds.add(write.id);
		if (write.kind === "entry") transactionEntryIds.add(write.id);
	}
}
