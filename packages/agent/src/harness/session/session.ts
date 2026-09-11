import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import type { AgentMessage } from "../../types.ts";
import type { Context } from "../context.ts";
import { insertEntry } from "./commit.ts";
import { MutationLine } from "./mutation-line.ts";
import type {
	Branch,
	BranchScan,
	CommitResult,
	Entry,
	EntryQuery,
	IdGenerator,
	JsonValue,
	Session,
	SessionMetadata,
	SessionMutation,
	SessionMutationCallback,
	SessionStats,
	Storage,
	StorageBranchScan,
	Write,
} from "./types.ts";
import {
	appendList as appendListWrite,
	branchTip,
	deleteList as deleteListWrite,
	deleteValue as deleteValueWrite,
	entryLabel,
	type ListElement,
	type ListReadOptions,
	type StoredValue,
	sessionName,
	setValue as setValueWrite,
	type Value,
	type ValueList,
} from "./values.ts";

export interface StorageBackedSessionOptions {
	mutationLine?: MutationLine;
	idGenerator?: IdGenerator;
	onClose?: () => void;
}

/** Durable session state is internally inconsistent and cannot be safely advanced. */
export class SessionInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionInvariantError";
	}
}

/** A requested Branch name is invalid. */
export class SessionInvalidBranchError extends Error {
	readonly branch: string;
	readonly reason: string;

	constructor(branch: string, reason: string) {
		super(`Invalid branch ${JSON.stringify(branch)}: ${reason}`);
		this.name = "SessionInvalidBranchError";
		this.branch = branch;
		this.reason = reason;
	}
}

/** A requested branch already exists. */
export class SessionBranchExistsError extends Error {
	readonly branch: string;

	constructor(branch: string) {
		super(`Branch already exists: ${branch}`);
		this.name = "SessionBranchExistsError";
		this.branch = branch;
	}
}

/** A pending assistant message cannot be persisted as a session entry. */
export class SessionPendingAssistantMessageError extends Error {
	constructor() {
		super("Cannot persist a pending assistant message");
		this.name = "SessionPendingAssistantMessageError";
	}
}

/** A requested session entry target does not exist. */
export class SessionUnknownTargetError extends Error {
	readonly targetId: string;

	constructor(targetId: string) {
		super(`Unknown target: ${targetId}`);
		this.name = "SessionUnknownTargetError";
		this.targetId = targetId;
	}
}

class StorageBackedSessionMutation implements SessionMutation {
	private readonly storage: Storage;
	private readonly release: () => void;
	private active = true;
	private commitResult: Promise<CommitResult> | undefined;
	private endPromise: Promise<void> | undefined;

	constructor(storage: Storage, release: () => void) {
		this.storage = storage;
		this.release = release;
	}

	commit(writes: Write[], context: Context): Promise<CommitResult> {
		this.assertActive();
		if (this.commitResult !== undefined) return Promise.reject(new Error("SessionMutator commit already attempted"));
		try {
			for (const write of writes) {
				if (
					write.kind === "entry" &&
					write.entry.type === "message" &&
					write.entry.message.role === "assistant" &&
					write.entry.message.stopReason === "pending"
				) {
					throw new SessionPendingAssistantMessageError();
				}
			}
			this.commitResult = this.storage.commit(writes, context);
		} catch (error) {
			this.commitResult = Promise.reject(error);
		}
		return this.commitResult;
	}

	end(_context: Context): Promise<void> {
		if (this.endPromise !== undefined) return this.endPromise;
		this.active = false;
		this.endPromise = this.settle().finally(this.release);
		return this.endPromise;
	}

	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		this.assertActive();
		return this.storage.getEntries(ids, context);
	}

	getStats(context: Context): Promise<SessionStats> {
		this.assertActive();
		return this.storage.getStats(context);
	}

	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		this.assertActive();
		return this.storage.getValue(address, context);
	}

	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		this.assertActive();
		return this.storage.scanValues(prefix, context);
	}

	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		this.assertActive();
		return this.storage.readList(address, options, context);
	}

	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]> {
		this.assertActive();
		return this.storage.scanBranch(query, context);
	}

	private settle(): Promise<void> {
		return (
			this.commitResult?.then(
				() => undefined,
				() => undefined,
			) ?? Promise.resolve()
		);
	}

	private assertActive(): void {
		if (!this.active) throw new Error("SessionMutator cannot be used outside its mutation callback");
	}
}

class StorageBackedBranch implements Branch {
	readonly name: string;
	private readonly session: StorageBackedSession;

	constructor(name: string, session: StorageBackedSession) {
		this.name = name;
		this.session = session;
	}

	getTipId(context: Context): Promise<string | null> {
		return this.session.getBranchTip(this.name, context);
	}

	async findEntries(query: BranchScan | undefined, context: Context): Promise<Entry[]> {
		query ??= {};
		const start = query.start ?? (await this.getTipId(context));
		if (start === null) return [];
		return this.session.scanBranch({ ...query, start, order: query.order ?? "newestFirst" }, context);
	}

	async findEntry(query: BranchScan | undefined, context: Context): Promise<Entry | undefined> {
		query ??= {};
		return (
			await this.findEntries({ ...query, limit: query.limit === undefined ? 1 : Math.min(query.limit, 1) }, context)
		)[0];
	}

	appendMessage(message: AgentMessage, context: Context): Promise<string> {
		return this.session.appendToBranch(this.name, { type: "message", message }, context);
	}

	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string> {
		return this.session.appendToBranch(
			this.name,
			{ type: "custom", customType, ...(data === undefined ? {} : { data }) },
			context,
		);
	}
}

/** Package-internal typed boundary shared by concrete session repositories. */
export class StorageBackedSession<TMetadata extends SessionMetadata = SessionMetadata> implements Session<TMetadata> {
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator;
	private readonly storage: Storage;
	private readonly mutationLine: MutationLine;
	private readonly onClose: (() => void) | undefined;
	private readonly branches = new Map<string, StorageBackedBranch>();
	private readonly closedError = new Error("Session is closed");
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(metadata: TMetadata, storage: Storage, options: StorageBackedSessionOptions = {}) {
		this.metadata = metadata;
		this.idGenerator = options.idGenerator ?? { next: uuidv7 };
		this.storage = storage;
		this.mutationLine = options.mutationLine ?? new MutationLine();
		this.onClose = options.onClose;
	}

	async beginMutation(_context: Context): Promise<SessionMutation> {
		this.assertOpen();
		let grant!: (mutation: SessionMutation) => void;
		let rejectGrant!: (error: unknown) => void;
		const granted = new Promise<SessionMutation>((resolve, reject) => {
			grant = resolve;
			rejectGrant = reject;
		});
		let release!: () => void;
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const line = this.mutationLine.run(async () => {
			grant(new StorageBackedSessionMutation(this.storage, release));
			await finished;
		});
		void line.catch(rejectGrant);
		return granted;
	}

	async mutate<T>(mutation: SessionMutationCallback<T>, context: Context): Promise<T> {
		const mutator = await this.beginMutation(context);
		try {
			return await mutation(mutator, context);
		} finally {
			await mutator.end(context);
		}
	}

	async getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		this.assertOpen();
		return this.storage.getEntries(ids, context);
	}

	async getEntry(id: string, context: Context): Promise<Entry | undefined> {
		return (await this.getEntries([id], context)).get(id);
	}

	async getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		this.assertOpen();
		return this.storage.getValue(address, context);
	}

	async scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		this.assertOpen();
		return this.storage.scanValues(prefix, context);
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		this.assertOpen();
		return this.storage.readList(address, options, context);
	}

	async scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]> {
		this.assertOpen();
		return this.storage.scanBranch(query, context);
	}

	async getStats(context: Context): Promise<SessionStats> {
		this.assertOpen();
		return this.storage.getStats(context);
	}

	async getName(context: Context): Promise<string | undefined> {
		return (await this.getValue(sessionName, context))?.value;
	}

	async getLabel(targetId: string, context: Context): Promise<string | undefined> {
		return (await this.getValue(entryLabel(targetId), context))?.value;
	}

	async findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]> {
		query ??= {};
		this.assertOpen();
		const order = query.order ?? "desc";
		if (query.cursor !== undefined) {
			if (order === "asc" && query.cursor.seq === Number.MAX_SAFE_INTEGER) return [];
			if (order === "desc" && query.cursor.seq <= 1) return [];
		}
		return this.storage.scanEntries(
			{
				type: query.type,
				customType: query.customType,
				order,
				limit: query.limit,
				...(query.cursor === undefined
					? {}
					: order === "asc"
						? { fromSeq: query.cursor.seq + 1 }
						: { toSeq: query.cursor.seq - 1 }),
			},
			context,
		);
	}

	async findEntry(query: EntryQuery | undefined, context: Context): Promise<Entry | undefined> {
		query ??= {};
		return (
			await this.findEntries({ ...query, limit: query.limit === undefined ? 1 : Math.min(query.limit, 1) }, context)
		)[0];
	}

	async branch(name: string, context: Context): Promise<Branch | undefined> {
		this.assertValidBranchName(name);
		if ((await this.getValue(branchTip(name), context)) === undefined) return undefined;
		return this.getOrCreateBranchObject(name);
	}

	async createBranch(name: string, at: string | null, context: Context): Promise<Branch> {
		this.assertOpen();
		this.assertValidBranchName(name);
		await this.mutate(async (mutator) => {
			if ((await mutator.getValue(branchTip(name), context)) !== undefined) {
				throw new SessionBranchExistsError(name);
			}
			if (at !== null && !(await mutator.getEntries([at], context)).has(at)) {
				throw new SessionUnknownTargetError(at);
			}
			await mutator.commit([setValueWrite(branchTip(name), at)], context);
		}, context);
		return this.getOrCreateBranchObject(name);
	}

	setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void> {
		return this.mutate(async (mutator) => {
			await mutator.commit([setValueWrite(address, next)], context);
		}, context);
	}

	deleteValue<T>(address: Value<T>, context: Context): Promise<void> {
		return this.mutate(async (mutator) => {
			await mutator.commit([deleteValueWrite(address)], context);
		}, context);
	}

	appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void> {
		return this.mutate(async (mutator) => {
			await mutator.commit([appendListWrite(address, element)], context);
		}, context);
	}

	deleteList<T>(address: ValueList<T>, context: Context): Promise<void> {
		return this.mutate(async (mutator) => {
			await mutator.commit([deleteListWrite(address)], context);
		}, context);
	}

	setName(name: string | undefined, context: Context): Promise<void> {
		return name === undefined ? this.deleteValue(sessionName, context) : this.setValue(sessionName, name, context);
	}

	setLabel(targetId: string, label: string | undefined, context: Context): Promise<void> {
		const address = entryLabel(targetId);
		return label === undefined ? this.deleteValue(address, context) : this.setValue(address, label, context);
	}

	close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.mutationLine
			.seal(this.closedError)
			.then(() => this.storage.close(context))
			.finally(() => {
				this.state = "closed";
				this.onClose?.();
			});
		return this.closePromise;
	}

	async getBranchTip(name: string, context: Context): Promise<string | null> {
		const stored = await this.getValue(branchTip(name), context);
		if (stored === undefined) throw new SessionInvariantError(`Unknown branch: ${name}`);
		return stored.value;
	}

	async appendToBranch(
		name: string,
		entry: { type: "message"; message: AgentMessage } | { type: "custom"; customType: string; data?: JsonValue },
		context: Context,
	): Promise<string> {
		this.assertOpen();
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "pending") {
			throw new SessionPendingAssistantMessageError();
		}
		const id = this.idGenerator.next();
		await this.mutate(async (mutator) => {
			const tip = await mutator.getValue(branchTip(name), context);
			if (tip === undefined) throw new SessionInvariantError(`Unknown branch: ${name}`);
			await mutator.commit(
				[
					insertEntry(
						entry.type === "message"
							? { id, parentId: tip.value, type: "message", message: entry.message }
							: {
									id,
									parentId: tip.value,
									type: "custom",
									customType: entry.customType,
									...(entry.data === undefined ? {} : { data: entry.data }),
								},
					),
					setValueWrite(branchTip(name), id),
				],
				context,
			);
		}, context);
		return id;
	}

	private getOrCreateBranchObject(name: string): Branch {
		let branch = this.branches.get(name);
		if (branch === undefined) {
			branch = new StorageBackedBranch(name, this);
			this.branches.set(name, branch);
		}
		return branch;
	}

	private assertValidBranchName(name: string): void {
		if (name.length === 0) throw new SessionInvalidBranchError(name, "branch name must not be empty");
		if (name.includes("\u0000")) {
			throw new SessionInvalidBranchError(name, "branch name must not contain \\u0000");
		}
	}

	private assertOpen(): void {
		if (this.state !== "open") throw this.closedError;
	}
}
