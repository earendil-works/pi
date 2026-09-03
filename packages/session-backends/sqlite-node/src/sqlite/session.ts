import type {
	Branch,
	Context,
	Entry,
	EntryQuery,
	ListElement,
	ListReadOptions,
	Session,
	SessionMutation,
	SessionMutationCallback,
	SessionStats,
	StorageBranchScan,
	StoredValue,
	Value,
	ValueList,
} from "@earendil-works/pi-agent-core";
import type { SqliteSessionMetadata } from "./session/session-row.ts";

export interface SqliteOpenSessionOptions {
	onClose: () => void;
}

/** SQLite-specific open-session lifecycle wrapper. */
export class SqliteOpenSession implements Session<SqliteSessionMetadata> {
	readonly metadata: SqliteSessionMetadata;
	readonly idGenerator: Session<SqliteSessionMetadata>["idGenerator"];
	private readonly session: Session<SqliteSessionMetadata>;
	private readonly onClose: () => void;
	private readonly admitted = new Set<Promise<unknown>>();
	private readonly closedError = new Error("Session is closed");
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(session: Session<SqliteSessionMetadata>, options: SqliteOpenSessionOptions) {
		this.session = session;
		this.metadata = session.metadata;
		this.idGenerator = session.idGenerator;
		this.onClose = options.onClose;
	}

	async beginMutation(context: Context): Promise<SessionMutation> {
		let resolveFinished!: () => void;
		const finished = new Promise<void>((resolve) => {
			resolveFinished = resolve;
		});
		this.admitted.add(finished);
		let source: SessionMutation;
		try {
			source = await this.admit(() => this.session.beginMutation(context));
		} catch (error) {
			this.admitted.delete(finished);
			resolveFinished();
			throw error;
		}
		if (this.state !== "open") {
			await source.end(context);
			this.admitted.delete(finished);
			resolveFinished();
			throw this.closedError;
		}
		let ended = false;
		return {
			commit: (writes, commitContext) => source.commit(writes, commitContext),
			end: async (endContext) => {
				try {
					await source.end(endContext);
				} finally {
					if (!ended) {
						ended = true;
						this.admitted.delete(finished);
						resolveFinished();
					}
				}
			},
			getEntries: (ids, readContext) => source.getEntries(ids, readContext),
			getStats: (readContext) => source.getStats(readContext),
			getValue: (address, readContext) => source.getValue(address, readContext),
			scanValues: (prefix, readContext) => source.scanValues(prefix, readContext),
			readList: (address, options, readContext) => source.readList(address, options, readContext),
			scanBranch: (query, readContext) => source.scanBranch(query, readContext),
		};
	}

	mutate<T>(mutation: SessionMutationCallback<T>, context: Context): Promise<T> {
		return this.admit(() =>
			this.session.mutate((mutator, mutationContext) => {
				if (this.state !== "open") throw this.closedError;
				return mutation(mutator, mutationContext);
			}, context),
		);
	}

	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		return this.admit(() => this.session.getEntries(ids, context));
	}

	getEntry(id: string, context: Context): Promise<Entry | undefined> {
		return this.admit(() => this.session.getEntry(id, context));
	}

	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		return this.admit(() => this.session.getValue(address, context));
	}

	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		return this.admit(() => this.session.scanValues(prefix, context));
	}

	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		return this.admit(() => this.session.readList(address, options, context));
	}

	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]> {
		return this.admit(() => this.session.scanBranch(query, context));
	}

	getStats(context: Context): Promise<SessionStats> {
		return this.admit(() => this.session.getStats(context));
	}

	getName(context: Context): Promise<string | undefined> {
		return this.admit(() => this.session.getName(context));
	}

	getLabel(targetId: string, context: Context): Promise<string | undefined> {
		return this.admit(() => this.session.getLabel(targetId, context));
	}

	findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]> {
		return this.admit(() => this.session.findEntries(query, context));
	}

	findEntry(query: EntryQuery | undefined, context: Context): Promise<Entry | undefined> {
		return this.admit(() => this.session.findEntry(query, context));
	}

	async branch(name: string, context: Context): Promise<Branch | undefined> {
		const branch = await this.admit(() => this.session.branch(name, context));
		return branch === undefined ? undefined : this.wrapBranch(branch);
	}

	async createBranch(name: string, at: string | null, context: Context): Promise<Branch> {
		return this.wrapBranch(await this.admit(() => this.session.createBranch(name, at, context)));
	}

	setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void> {
		return this.admit(() => this.session.setValue(address, next, context));
	}

	deleteValue<T>(address: Value<T>, context: Context): Promise<void> {
		return this.admit(() => this.session.deleteValue(address, context));
	}

	appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void> {
		return this.admit(() => this.session.appendList(address, element, context));
	}

	deleteList<T>(address: ValueList<T>, context: Context): Promise<void> {
		return this.admit(() => this.session.deleteList(address, context));
	}

	setName(name: string | undefined, context: Context): Promise<void> {
		return this.admit(() => this.session.setName(name, context));
	}

	setLabel(targetId: string, label: string | undefined, context: Context): Promise<void> {
		return this.admit(() => this.session.setLabel(targetId, label, context));
	}

	close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = Promise.allSettled([...this.admitted])
			.then(() => this.session.close(context))
			.finally(() => {
				this.state = "closed";
				this.onClose();
			});
		return this.closePromise;
	}

	private wrapBranch(branch: Branch): Branch {
		return {
			name: branch.name,
			getTipId: (context) => this.admit(() => branch.getTipId(context)),
			findEntries: (query, context) => this.admit(() => branch.findEntries(query, context)),
			findEntry: (query, context) => this.admit(() => branch.findEntry(query, context)),
			appendMessage: (message, context) => this.admit(() => branch.appendMessage(message, context)),
			appendCustomEntry: (customType, data, context) =>
				this.admit(() => branch.appendCustomEntry(customType, data, context)),
		};
	}

	private admit<T>(operation: () => Promise<T>): Promise<T> {
		if (this.state !== "open") return Promise.reject(this.closedError);
		let result: Promise<T>;
		try {
			result = operation();
		} catch (error) {
			result = Promise.reject(error);
		}
		this.admitted.add(result);
		void result.then(
			() => this.admitted.delete(result),
			() => this.admitted.delete(result),
		);
		return result;
	}
}
