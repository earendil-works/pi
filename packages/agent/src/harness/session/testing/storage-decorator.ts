import type { Context } from "../../context.ts";
import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	SessionStats,
	Storage,
	StorageBranchScan,
	UsageRow,
	UsageScan,
	Write,
} from "../types.ts";
import type { ListElement, ListReadOptions, StoredValue, Value, ValueList } from "../values.ts";

/** Test-only forwarding base for decorators that alter one part of Storage behavior. */
export class StorageDecorator implements Storage {
	protected readonly delegate: Storage;

	constructor(delegate: Storage) {
		this.delegate = delegate;
	}

	commit(writes: Write[], context: Context): Promise<CommitResult> {
		return this.delegate.commit(writes, context);
	}

	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		return this.delegate.getEntries(ids, context);
	}

	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		return this.delegate.getValue(address, context);
	}

	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		return this.delegate.scanValues(prefix, context);
	}

	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		return this.delegate.readList(address, options, context);
	}

	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]> {
		return this.delegate.scanBranch(query, context);
	}

	scanBranchStructure(query: StorageBranchScan, context: Context): Promise<EntryStructure[]> {
		return this.delegate.scanBranchStructure(query, context);
	}

	scanEntries(query: EntryScan, context: Context): Promise<Entry[]> {
		return this.delegate.scanEntries(query, context);
	}

	scanUsage(query: UsageScan, context: Context): Promise<UsageRow[]> {
		return this.delegate.scanUsage(query, context);
	}

	getStats(context: Context): Promise<SessionStats> {
		return this.delegate.getStats(context);
	}

	close(context: Context): Promise<void> {
		return this.delegate.close(context);
	}
}
