import type { Context, JsonValue } from "@earendil-works/chord";
import type { FileError, FileSystem } from "../../env/index.ts";
import { idFromNumber, seqFromNumber } from "../../ids.ts";
import type {
	ConversationId,
	ConversationQuery,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	EntryId,
	EntryQuery,
	Id,
	Seq,
	Storage,
	StorageWrite,
	SubmissionId,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "../../types.ts";
import { MemoryStorage } from "../memory.ts";

const FORMAT_VERSION = 1;
const MAIN_FILE = "main.jsonl";
const RECLAIM_SUFFIX = ".reclaim";
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

type MainOperation =
	| Extract<StorageWrite, { readonly type: "conversation" | "entry" | "submission" | "document.retire" }>
	| { readonly type: "task"; readonly value: StoredTask }
	| { readonly type: "task.sidecar"; readonly id: TaskId; readonly ordinal: number }
	| { readonly type: "document.create"; readonly record: DocumentCreate; readonly ordinal: number }
	| { readonly type: "document.change"; readonly id: DocumentId; readonly ordinal: number };

type MainMarker = {
	readonly format: typeof FORMAT_VERSION;
	readonly type: "commit";
	readonly seq: Seq;
	readonly writes: readonly MainOperation[];
};

type SidecarPayload =
	| { readonly type: "task"; readonly value: StoredTask }
	| { readonly type: "document"; readonly id: DocumentId; readonly content: DocumentContent };

type SidecarRecord = {
	readonly format: typeof FORMAT_VERSION;
	readonly type: "record";
	readonly seq: Seq;
	readonly ordinal: number;
	readonly payload: SidecarPayload;
};

type ParsedLine<T> = {
	readonly value: T;
	readonly start: number;
};

type ParsedFile<T> = {
	readonly path: string;
	readonly lines: readonly ParsedLine<T>[];
};

type EncodedCommit = {
	readonly marker: string;
	readonly sidecars: ReadonlyMap<string, string>;
};

export type JsonlStorageOptions = {
	/** Flush every affected sidecar before appending the main marker. Defaults to false. */
	readonly fsync?: boolean;
};

export class JsonlCorruptionError extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "JsonlCorruptionError";
	}
}

export class JsonlStoragePoisonedError extends Error {
	constructor(cause: Error) {
		super("JSONL storage is poisoned and must be reopened", { cause });
		this.name = "JsonlStoragePoisonedError";
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

const sidecarFileName = (kind: "doc" | "task", id: DocumentId | TaskId): string => `${kind}-${id}.jsonl`;

const isSidecarFileName = (name: string): boolean => /^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl$/.test(name);

const isReclaimFileName = (name: string): boolean => /^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl\.reclaim$/.test(name);

const isCurrentOnly = (record: DocumentCreate): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

const sidecarKey = (file: string, seq: Seq, ordinal: number): string => JSON.stringify([file, seq, ordinal]);

const jsonLine = (value: MainMarker | SidecarRecord): string => `${JSON.stringify(value)}\n`;

const errorFromFile = (action: string, error: FileError): Error =>
	new Error(`JSONL ${action} failed: ${error.message}`, { cause: error });

const parseJson = (text: string, description: string): unknown => {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new JsonlCorruptionError(`Malformed complete ${description}`, error instanceof Error ? error : undefined);
	}
};

const validateMainOperation = (value: unknown, description: string): MainOperation => {
	if (!isObject(value) || typeof value.type !== "string") {
		throw new JsonlCorruptionError(`Invalid write in ${description}`);
	}
	switch (value.type) {
		case "conversation":
		case "entry":
		case "submission":
			if (!isObject(value.value) || !isSafeInteger(value.value.id)) {
				throw new JsonlCorruptionError(`Invalid ${value.type} write in ${description}`);
			}
			return value as MainOperation;
		case "task":
			if (
				!isObject(value.value) ||
				!isSafeInteger(value.value.id) ||
				!isObject(value.value.state) ||
				value.value.state.status !== "terminal"
			) {
				throw new JsonlCorruptionError(`Invalid terminal task write in ${description}`);
			}
			return value as MainOperation;
		case "document.retire":
			if (!isSafeInteger(value.id)) throw new JsonlCorruptionError(`Invalid document retirement in ${description}`);
			return value as MainOperation;
		case "task.sidecar":
			if (!isSafeInteger(value.id) || !isSafeInteger(value.ordinal) || value.ordinal < 0) {
				throw new JsonlCorruptionError(`Invalid task sidecar write in ${description}`);
			}
			return value as MainOperation;
		case "document.create":
			if (
				!isObject(value.record) ||
				!isSafeInteger(value.record.id) ||
				!isSafeInteger(value.ordinal) ||
				value.ordinal < 0
			) {
				throw new JsonlCorruptionError(`Invalid document creation in ${description}`);
			}
			return value as MainOperation;
		case "document.change":
			if (!isSafeInteger(value.id) || !isSafeInteger(value.ordinal) || value.ordinal < 0) {
				throw new JsonlCorruptionError(`Invalid document change in ${description}`);
			}
			return value as MainOperation;
		default:
			throw new JsonlCorruptionError(`Unknown write type in ${description}`);
	}
};

const parseMainMarker = (text: string, line: number): MainMarker => {
	const description = `${MAIN_FILE} line ${line}`;
	const value = parseJson(text, description);
	if (
		!isObject(value) ||
		value.format !== FORMAT_VERSION ||
		value.type !== "commit" ||
		!isSafeInteger(value.seq) ||
		value.seq < 1 ||
		!Array.isArray(value.writes)
	) {
		throw new JsonlCorruptionError(`Invalid commit marker in ${description}`);
	}
	return {
		format: FORMAT_VERSION,
		type: "commit",
		seq: seqFromNumber(value.seq),
		writes: value.writes.map((write) => validateMainOperation(write, description)),
	};
};

const validateDocumentContent = (value: unknown, description: string): DocumentContent => {
	if (!isObject(value) || !isSafeInteger(value.version) || value.version < 1) {
		throw new JsonlCorruptionError(`Invalid document content in ${description}`);
	}
	if (value.kind === "base" && isObject(value.value)) return value as DocumentContent;
	if (value.kind === "delta" && Array.isArray(value.ops)) return value as DocumentContent;
	throw new JsonlCorruptionError(`Invalid document content in ${description}`);
};

const parseSidecarRecord = (text: string, file: string, line: number): SidecarRecord => {
	const description = `${file} line ${line}`;
	const value = parseJson(text, description);
	if (
		!isObject(value) ||
		value.format !== FORMAT_VERSION ||
		value.type !== "record" ||
		!isSafeInteger(value.seq) ||
		value.seq < 1 ||
		!isSafeInteger(value.ordinal) ||
		value.ordinal < 0 ||
		!isObject(value.payload) ||
		typeof value.payload.type !== "string"
	) {
		throw new JsonlCorruptionError(`Invalid sidecar record in ${description}`);
	}
	if (value.payload.type === "task") {
		if (
			!isObject(value.payload.value) ||
			!isSafeInteger(value.payload.value.id) ||
			!isObject(value.payload.value.state) ||
			(value.payload.value.state.status !== "pending" && value.payload.value.state.status !== "running")
		) {
			throw new JsonlCorruptionError(`Invalid live task record in ${description}`);
		}
	} else if (value.payload.type === "document") {
		if (!isSafeInteger(value.payload.id)) {
			throw new JsonlCorruptionError(`Invalid document record in ${description}`);
		}
		validateDocumentContent(value.payload.content, description);
	} else {
		throw new JsonlCorruptionError(`Unknown sidecar record type in ${description}`);
	}
	return value as SidecarRecord;
};

/** Portable JSONL implementation of the storage contract. */
export class JsonlStorage implements Storage {
	private readonly fs: FileSystem;
	private readonly directory: string;
	private readonly mainPath: string;
	private readonly fsync: boolean;
	private readonly memory = new MemoryStorage();
	private readonly currentOnlyDocuments = new Set<DocumentId>();
	private readonly liveTaskSidecars = new Set<TaskId>();
	private closed = false;
	private poisonError: JsonlStoragePoisonedError | undefined;

	private constructor(fs: FileSystem, directory: string, mainPath: string, options: JsonlStorageOptions) {
		this.fs = fs;
		this.directory = directory;
		this.mainPath = mainPath;
		this.fsync = options.fsync ?? false;
	}

	/** Open or create a JSONL storage directory using the supplied filesystem. */
	static async open(
		directory: string,
		fs: FileSystem,
		context: Context,
		options: JsonlStorageOptions = {},
	): Promise<JsonlStorage> {
		const absolute = await fs.absolutePath(directory, context);
		if (!absolute.ok) throw errorFromFile("path resolution", absolute.error);
		const created = await fs.createDir(absolute.value, { recursive: true }, context);
		if (!created.ok) throw errorFromFile("directory creation", created.error);
		const mainPathResult = await fs.joinPath([absolute.value, MAIN_FILE], context);
		if (!mainPathResult.ok) throw errorFromFile("path join", mainPathResult.error);
		const storage = new JsonlStorage(fs, absolute.value, mainPathResult.value, options);
		await storage.recover(context);
		return storage;
	}

	async commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
		this.assertUsable();
		const prepared = this.memory.prepareCommit(writes);
		const encoded = this.encodeCommit(prepared.seq, prepared.writes);
		const reclamations = this.planReclamations(prepared.writes, encoded);
		const sidecars = await Promise.all(
			[...encoded.sidecars].map(async ([file, content]) => ({
				file,
				content,
				path: await this.resolveFile(file, context),
			})),
		);

		for (const sidecar of sidecars) {
			const result = await this.fs.appendFile(sidecar.path, sidecar.content, context);
			if (!result.ok) throw this.poison(errorFromFile(`append to ${sidecar.file}`, result.error));
		}
		if (this.fsync) {
			for (const sidecar of sidecars) {
				const result = await this.fs.flushFile(sidecar.path, context);
				if (!result.ok) throw this.poison(errorFromFile(`flush of ${sidecar.file}`, result.error));
			}
		}
		const marker = await this.fs.appendFile(this.mainPath, encoded.marker, context);
		if (!marker.ok) throw this.poison(errorFromFile(`append to ${MAIN_FILE}`, marker.error));
		const seq = prepared.apply();
		this.adoptSidecarState(prepared.writes);
		await this.reclaimSidecars(reclamations, context);
		return seq;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		return this.store.mintId<I>();
	}

	async conversation(id: ConversationId, context: Context) {
		return this.store.conversation(id, context);
	}

	async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return this.store.scanConversations(query, limit, cursor, context);
	}

	entry(id: EntryId, context: Context): ReturnType<Storage["entry"]>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<Storage["entry"]>;
	async entry(idOrConversationId: EntryId | ConversationId, idOrContext: EntryId | Context, context?: Context) {
		if (context === undefined)
			return this.store.entry(idFromNumber<EntryId>(idOrConversationId), idOrContext as Context);
		if (typeof idOrContext !== "number") throw new TypeError("Storage.entry() requires an entry ID");
		return this.store.entry(
			idFromNumber<ConversationId>(idOrConversationId),
			idFromNumber<EntryId>(idOrContext),
			context,
		);
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	) {
		return this.store.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context);
	}

	async scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return this.store.scanEntries(query, limit, cursor, context);
	}

	async task(id: TaskId, context: Context) {
		return this.store.task(id, context);
	}

	async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return this.store.scanTasks(query, limit, cursor, context);
	}

	async submission(id: SubmissionId, context: Context) {
		return this.store.submission(id, context);
	}

	async submissionByRequest(conversationId: ConversationId, requestId: string, context: Context) {
		return this.store.submissionByRequest(conversationId, requestId, context);
	}

	async findDocument(address: DocumentAddress, at: DocumentPoint, context: Context) {
		return this.store.findDocument(address, at, context);
	}

	async document(id: DocumentId, at: DocumentPoint, context: Context) {
		return this.store.document(id, at, context);
	}

	async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return this.store.scanDocuments(query, limit, cursor, context);
	}

	async close(context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.memory.close(context);
	}

	private encodeCommit(seq: Seq, writes: readonly StorageWrite[]): EncodedCommit {
		const mainWrites: MainOperation[] = [];
		const records = new Map<string, SidecarRecord[]>();
		let nextOrdinal = 0;
		const addSidecar = (file: string, payload: SidecarPayload): number => {
			const ordinal = nextOrdinal++;
			let fileRecords = records.get(file);
			if (fileRecords === undefined) {
				fileRecords = [];
				records.set(file, fileRecords);
			}
			fileRecords.push({ format: FORMAT_VERSION, type: "record", seq, ordinal, payload });
			return ordinal;
		};

		for (const write of writes) {
			switch (write.type) {
				case "conversation":
				case "entry":
				case "submission":
				case "document.retire":
					mainWrites.push(write);
					break;
				case "task":
					if (write.value.state.status === "terminal") mainWrites.push(write);
					else {
						const ordinal = addSidecar(sidecarFileName("task", write.value.id), {
							type: "task",
							value: write.value,
						});
						mainWrites.push({ type: "task.sidecar", id: write.value.id, ordinal });
					}
					break;
				case "document.create": {
					const ordinal = addSidecar(sidecarFileName("doc", write.record.id), {
						type: "document",
						id: write.record.id,
						content: write.content,
					});
					mainWrites.push({ type: "document.create", record: write.record, ordinal });
					break;
				}
				case "document.change": {
					const ordinal = addSidecar(sidecarFileName("doc", write.id), {
						type: "document",
						id: write.id,
						content: write.content,
					});
					mainWrites.push({ type: "document.change", id: write.id, ordinal });
					break;
				}
			}
		}

		const sidecars = new Map<string, string>();
		for (const [file, fileRecords] of records) {
			sidecars.set(file, fileRecords.map((record) => jsonLine(record)).join(""));
		}
		const marker: MainMarker = {
			format: FORMAT_VERSION,
			type: "commit",
			seq,
			writes: mainWrites,
		};
		return { marker: jsonLine(marker), sidecars };
	}

	private planReclamations(writes: readonly StorageWrite[], encoded: EncodedCommit): ReadonlyMap<string, string> {
		const createdCurrentOnlyDocuments = new Set<DocumentId>();
		const retiredDocuments = new Set<DocumentId>();
		const baseDocuments = new Set<DocumentId>();
		const finalTasks = new Map<TaskId, StoredTask>();
		for (const write of writes) {
			switch (write.type) {
				case "document.create":
					if (isCurrentOnly(write.record)) createdCurrentOnlyDocuments.add(write.record.id);
					break;
				case "document.change":
					if (write.content.kind === "base") baseDocuments.add(write.id);
					break;
				case "document.retire":
					retiredDocuments.add(write.id);
					break;
				case "task":
					finalTasks.set(write.value.id, write.value);
					break;
			}
		}

		const replacements = new Map<string, string>();
		const isCurrentOnlyDocument = (id: DocumentId): boolean =>
			this.currentOnlyDocuments.has(id) || createdCurrentOnlyDocuments.has(id);
		for (const id of retiredDocuments) {
			if (isCurrentOnlyDocument(id)) replacements.set(sidecarFileName("doc", id), "");
		}
		for (const id of baseDocuments) {
			if (!isCurrentOnlyDocument(id) || retiredDocuments.has(id)) continue;
			const file = sidecarFileName("doc", id);
			const content = encoded.sidecars.get(file);
			if (content !== undefined) replacements.set(file, content);
		}
		for (const [id, task] of finalTasks) {
			if (
				task.state.status === "terminal" &&
				(this.liveTaskSidecars.has(id) || encoded.sidecars.has(sidecarFileName("task", id)))
			) {
				replacements.set(sidecarFileName("task", id), "");
			}
		}
		return replacements;
	}

	private adoptSidecarState(writes: readonly StorageWrite[]): void {
		for (const write of writes) {
			if (write.type === "document.create") {
				if (isCurrentOnly(write.record)) this.currentOnlyDocuments.add(write.record.id);
			} else if (write.type === "task") {
				if (write.value.state.status === "terminal") this.liveTaskSidecars.delete(write.value.id);
				else this.liveTaskSidecars.add(write.value.id);
			}
		}
	}

	/** The marker already published this state, so reclamation is retryable best-effort maintenance. */
	private async reclaimSidecars(replacements: ReadonlyMap<string, string>, context: Context): Promise<void> {
		if (replacements.size === 0) return;
		if (this.fsync) {
			const flushed = await this.fs.flushFile(this.mainPath, context);
			if (!flushed.ok) return;
		}
		for (const [file, content] of replacements) await this.replaceSidecar(file, content, context);
	}

	private async replaceSidecar(file: string, content: string, context: Context): Promise<void> {
		const path = await this.fs.joinPath([this.directory, file], context);
		if (!path.ok) return;
		if (content === "") {
			await this.fs.remove(path.value, { force: true }, context);
			return;
		}
		const temporaryPath = await this.fs.joinPath([this.directory, `${file}${RECLAIM_SUFFIX}`], context);
		if (!temporaryPath.ok) return;
		const written = await this.fs.writeFile(temporaryPath.value, content, context);
		if (!written.ok) return;
		if (this.fsync) {
			const flushed = await this.fs.flushFile(temporaryPath.value, context);
			if (!flushed.ok) return;
		}
		await this.fs.renameFile(temporaryPath.value, path.value, context);
	}

	private async recover(context: Context): Promise<void> {
		const fs = this.fs;
		const directory = this.directory;
		const memory = this.memory;
		const main = await JsonlStorage.readLines(fs, this.mainPath, MAIN_FILE, context, (text, line) =>
			parseMainMarker(text, line),
		);
		let previousSeq = 0;
		for (const marker of main.lines) {
			if (marker.value.seq <= previousSeq) {
				throw new JsonlCorruptionError(`Commit sequence does not strictly increase in ${MAIN_FILE}`);
			}
			previousSeq = marker.value.seq;
		}

		const listed = await fs.listDir(directory, context);
		if (!listed.ok) throw errorFromFile("directory listing", listed.error);
		for (const info of listed.value) {
			if (info.kind === "file" && isReclaimFileName(info.name)) {
				await fs.remove(info.path, { force: true }, context);
			}
		}
		const sidecarFiles = listed.value
			.filter((info) => info.kind === "file" && isSidecarFileName(info.name))
			.map((info) => info.name)
			.sort();
		const parsedFiles = new Map<string, ParsedFile<SidecarRecord>>();
		const recordByKey = new Map<string, ParsedLine<SidecarRecord>>();
		for (const file of sidecarFiles) {
			const pathResult = await fs.joinPath([directory, file], context);
			if (!pathResult.ok) throw errorFromFile("path join", pathResult.error);
			const parsed = await JsonlStorage.readLines(fs, pathResult.value, file, context, (text, line) =>
				parseSidecarRecord(text, file, line),
			);
			parsedFiles.set(file, parsed);
			let previous: SidecarRecord | undefined;
			for (const line of parsed.lines) {
				if (
					previous !== undefined &&
					(line.value.seq < previous.seq ||
						(line.value.seq === previous.seq && line.value.ordinal <= previous.ordinal))
				) {
					throw new JsonlCorruptionError(`Sidecar records are out of order in ${file}`);
				}
				previous = line.value;
				recordByKey.set(sidecarKey(file, line.value.seq, line.value.ordinal), line);
			}
		}

		const currentOnlyDocuments = new Set<DocumentId>();
		const retiredDocuments = new Set<DocumentId>();
		const finalTaskIsLive = new Map<TaskId, boolean>();
		for (const { value: marker } of main.lines) {
			for (const operation of marker.writes) {
				if (operation.type === "document.create") {
					if (isCurrentOnly(operation.record)) currentOnlyDocuments.add(operation.record.id);
				} else if (operation.type === "document.retire") {
					retiredDocuments.add(operation.id);
				} else if (operation.type === "task") {
					finalTaskIsLive.set(operation.value.id, false);
				} else if (operation.type === "task.sidecar") {
					finalTaskIsLive.set(operation.id, true);
				}
			}
		}
		const retiredCurrentOnlyDocuments = new Set([...retiredDocuments].filter((id) => currentOnlyDocuments.has(id)));

		const latestBases = new Map<DocumentId, SidecarRecord>();
		for (const { value: marker } of main.lines) {
			for (const operation of marker.writes) {
				if (operation.type !== "document.create" && operation.type !== "document.change") continue;
				const id = operation.type === "document.create" ? operation.record.id : operation.id;
				if (!currentOnlyDocuments.has(id)) continue;
				const record = recordByKey.get(
					sidecarKey(sidecarFileName("doc", id), marker.seq, operation.ordinal),
				)?.value;
				if (
					record?.payload.type !== "document" ||
					record.payload.id !== id ||
					record.payload.content.kind !== "base"
				) {
					continue;
				}
				const previous = latestBases.get(id);
				if (
					previous === undefined ||
					record.seq > previous.seq ||
					(record.seq === previous.seq && record.ordinal > previous.ordinal)
				) {
					latestBases.set(id, record);
				}
			}
		}

		const isBeforeLatestBase = (id: DocumentId, seq: Seq, ordinal: number): boolean => {
			const base = latestBases.get(id);
			return base !== undefined && (seq < base.seq || (seq === base.seq && ordinal < base.ordinal));
		};
		const terminalTasks = new Set([...finalTaskIsLive].filter(([, live]) => !live).map(([id]) => id));
		const confirmed = new Set<string>();
		for (const line of main.lines) {
			const marker = line.value;
			const writes: StorageWrite[] = [];
			for (const operation of marker.writes) {
				switch (operation.type) {
					case "conversation":
					case "entry":
					case "submission":
					case "task":
					case "document.retire":
						writes.push(operation);
						break;
					case "task.sidecar": {
						const optional = terminalTasks.has(operation.id);
						const record = JsonlStorage.confirmRecord(
							marker,
							operation.ordinal,
							sidecarFileName("task", operation.id),
							recordByKey,
							confirmed,
							optional,
						);
						if (record !== undefined) {
							if (record.payload.type !== "task" || record.payload.value.id !== operation.id) {
								throw new JsonlCorruptionError(
									`Confirmed task sidecar data does not match commit ${marker.seq}`,
								);
							}
							if (!optional) writes.push({ type: "task", value: record.payload.value });
						}
						break;
					}
					case "document.create":
					case "document.change": {
						const id = operation.type === "document.create" ? operation.record.id : operation.id;
						const reclaimed =
							retiredCurrentOnlyDocuments.has(id) || isBeforeLatestBase(id, marker.seq, operation.ordinal);
						const record = JsonlStorage.confirmRecord(
							marker,
							operation.ordinal,
							sidecarFileName("doc", id),
							recordByKey,
							confirmed,
							reclaimed,
						);
						let content: DocumentContent | undefined;
						if (record !== undefined) {
							if (record.payload.type !== "document" || record.payload.id !== id) {
								throw new JsonlCorruptionError(
									`Confirmed document sidecar data does not match commit ${marker.seq}`,
								);
							}
							content = record.payload.content;
						}
						if (operation.type === "document.create") {
							if (content !== undefined && content.kind !== "base") {
								throw new JsonlCorruptionError(
									`Document creation lacks a confirmed base in commit ${marker.seq}`,
								);
							}
							writes.push({
								type: "document.create",
								record: operation.record,
								content: reclaimed || content === undefined ? { kind: "base", version: 1, value: {} } : content,
							});
						} else if (!reclaimed && content !== undefined) {
							writes.push({ type: "document.change", id, content });
						}
						break;
					}
				}
			}
			try {
				memory.prepareCommit(writes, marker.seq).apply();
			} catch (error) {
				throw new JsonlCorruptionError(
					`Invalid committed state at sequence ${marker.seq}`,
					error instanceof Error ? error : undefined,
				);
			}
		}

		const reclamations = new Map<string, string>();
		for (const [file, parsed] of parsedFiles) {
			let unconfirmedAt: number | undefined;
			for (const line of parsed.lines) {
				const key = sidecarKey(file, line.value.seq, line.value.ordinal);
				if (confirmed.has(key)) {
					if (unconfirmedAt !== undefined) {
						throw new JsonlCorruptionError(`Confirmed record follows an unconfirmed tail in ${file}`);
					}
				} else if (unconfirmedAt === undefined) {
					unconfirmedAt = line.start;
				}
			}
			if (unconfirmedAt !== undefined) {
				const truncated = await fs.truncateFile(parsed.path, unconfirmedAt, context);
				if (!truncated.ok) throw errorFromFile(`tail truncation of ${file}`, truncated.error);
			}

			const numericId = Number(file.slice(file.indexOf("-") + 1, -".jsonl".length));
			const confirmedLines = parsed.lines.filter((line) =>
				confirmed.has(sidecarKey(file, line.value.seq, line.value.ordinal)),
			);
			let retainedLines: readonly ParsedLine<SidecarRecord>[] | undefined;
			if (file.startsWith("task-") && terminalTasks.has(idFromNumber<TaskId>(numericId))) {
				retainedLines = [];
			} else if (file.startsWith("doc-")) {
				const documentId = idFromNumber<DocumentId>(numericId);
				if (retiredCurrentOnlyDocuments.has(documentId)) {
					retainedLines = [];
				} else if (latestBases.has(documentId)) {
					retainedLines = confirmedLines.filter(
						(line) => !isBeforeLatestBase(documentId, line.value.seq, line.value.ordinal),
					);
				}
			}
			if (
				retainedLines !== undefined &&
				(retainedLines.length < confirmedLines.length || retainedLines.length === 0)
			) {
				reclamations.set(file, retainedLines.map((line) => jsonLine(line.value)).join(""));
			}
		}
		await this.reclaimSidecars(reclamations, context);

		for (const id of currentOnlyDocuments) this.currentOnlyDocuments.add(id);
		for (const [id, live] of finalTaskIsLive) {
			if (live) this.liveTaskSidecars.add(id);
		}
	}

	private static confirmRecord(
		marker: MainMarker,
		ordinal: number,
		file: string,
		recordByKey: ReadonlyMap<string, ParsedLine<SidecarRecord>>,
		confirmed: Set<string>,
		optional: boolean,
	): SidecarRecord | undefined {
		const key = sidecarKey(file, marker.seq, ordinal);
		if (confirmed.has(key)) throw new JsonlCorruptionError(`Sidecar record is confirmed more than once`);
		const line = recordByKey.get(key);
		if (line === undefined) {
			if (optional) return undefined;
			throw new JsonlCorruptionError(`Missing confirmed sidecar record ${file} at sequence ${marker.seq}`);
		}
		confirmed.add(key);
		return line.value;
	}

	private static async readLines<T>(
		fs: FileSystem,
		path: string,
		name: string,
		context: Context,
		parse: (text: string, line: number) => T,
	): Promise<ParsedFile<T>> {
		const read = await fs.readBinaryFile(path, context);
		if (!read.ok) {
			if (read.error.code === "not_found") return { path, lines: [] };
			throw errorFromFile(`read of ${name}`, read.error);
		}
		const bytes = read.value;
		let completeSize = bytes.length;
		if (completeSize > 0 && bytes[completeSize - 1] !== 0x0a) {
			completeSize = bytes.lastIndexOf(0x0a) + 1;
			const truncated = await fs.truncateFile(path, completeSize, context);
			if (!truncated.ok) throw errorFromFile(`torn-line truncation of ${name}`, truncated.error);
		}
		const lines: ParsedLine<T>[] = [];
		let start = 0;
		let lineNumber = 1;
		for (let end = 0; end < completeSize; end++) {
			if (bytes[end] !== 0x0a) continue;
			let text: string;
			try {
				text = textDecoder.decode(bytes.subarray(start, end));
			} catch (error) {
				throw new JsonlCorruptionError(
					`Invalid UTF-8 in complete ${name} line ${lineNumber}`,
					error instanceof Error ? error : undefined,
				);
			}
			lines.push({ value: parse(text, lineNumber), start });
			start = end + 1;
			lineNumber++;
		}
		return { path, lines };
	}

	private async resolveFile(file: string, context: Context): Promise<string> {
		const path = await this.fs.joinPath([this.directory, file], context);
		if (!path.ok) throw errorFromFile("path join", path.error);
		return path.value;
	}

	private get store(): MemoryStorage {
		this.assertUsable();
		return this.memory;
	}

	private poison(cause: Error): JsonlStoragePoisonedError {
		this.poisonError ??= new JsonlStoragePoisonedError(cause);
		return this.poisonError;
	}

	private assertUsable(): void {
		if (this.closed) throw new Error("JsonlStorage is closed");
		if (this.poisonError !== undefined) throw this.poisonError;
	}
}
