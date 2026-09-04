import type { Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import type { Context } from "../../context.ts";
import type { FileError, FileSystem, Result } from "../../types.ts";
import { insertUsage } from "../commit.ts";
import { type ForkDestinationSnapshot, type ForkSourceSnapshot, forkSnapshotWrites } from "../fork.ts";
import {
	type CommittedEntryWrite,
	type CommittedListAppendWrite,
	type CommittedListDeleteWrite,
	type CommittedUsageWrite,
	type CommittedValueDeleteWrite,
	type CommittedValueSetWrite,
	type CommittedWrite,
	InMemoryStorageState,
} from "../in-memory-storage-state.ts";
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
import { type LegacyV3SessionHeader, parseJsonlSessionHeader } from "./codec.ts";
import { normalizeLegacyV3Header, normalizeLegacyV3Records } from "./legacy-v3.ts";
import { JSONL_STORAGE_VERSION, type JsonlStorageHeader, type JsonlStorageOptions } from "./types.ts";

function fileValue<T>(result: Result<T, FileError>, action: string): T {
	if (!result.ok) throw new Error(`${action}: ${result.error.message}`, { cause: result.error });
	return result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSafeInteger(value: unknown, field: string, minimum: number): void {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid JSONL ${field}`);
}

function parseCommittedWrite(value: unknown): CommittedWrite {
	if (!isRecord(value)) throw new Error("Invalid JSONL transaction write");
	requireSafeInteger(value.seq, "write seq", 1);
	switch (value.kind) {
		case "entry":
			requireSafeInteger(value.timestamp, "entry timestamp", 0);
			return value as unknown as CommittedEntryWrite;
		case "usage":
			return value as unknown as CommittedUsageWrite;
		case "value":
			if (value.op === "set") return value as unknown as CommittedValueSetWrite;
			if (value.op === "delete") return value as unknown as CommittedValueDeleteWrite;
			throw new Error(`Invalid JSONL value operation: ${String(value.op)}`);
		case "list":
			if (value.op === "append") return value as unknown as CommittedListAppendWrite;
			if (value.op === "delete") return value as unknown as CommittedListDeleteWrite;
			throw new Error(`Invalid JSONL list operation: ${String(value.op)}`);
		default:
			throw new Error(`Invalid JSONL write kind: ${String(value.kind)}`);
	}
}

function parseTransaction(line: string): CommittedWrite[] {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Invalid JSONL transaction: not valid JSON", { cause: error });
	}
	return (Array.isArray(value) ? value : [value]).map(parseCommittedWrite);
}

function serializeTransaction(writes: CommittedWrite[]): string {
	return JSON.stringify(writes.length === 1 ? writes[0] : writes);
}

function serializeStorage(header: JsonlStorageHeader, transactions: CommittedWrite[][]): string {
	return `${[JSON.stringify(header), ...transactions.map(serializeTransaction)].join("\n")}\n`;
}

function splitCompleteLines(content: string): { lines: string[]; torn: boolean } {
	if (content.endsWith("\n")) return { lines: content.slice(0, -1).split("\n"), torn: false };
	const lastNewline = content.lastIndexOf("\n");
	if (lastNewline === -1) return { lines: [], torn: true };
	return { lines: content.slice(0, lastNewline).split("\n"), torn: true };
}

async function publishFileAtomically(
	fileSystem: FileSystem,
	destinationPath: string,
	content: string,
	context: Context,
): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		fileValue(
			await fileSystem.writeFile(tempPath, content, context),
			`Failed to stage JSONL storage ${destinationPath}`,
		);
		fileValue(
			await fileSystem.renameFile(tempPath, destinationPath, context),
			`Failed to publish JSONL storage ${destinationPath}`,
		);
	} catch (error) {
		await fileSystem.remove(tempPath, { force: true }, context);
		throw error;
	}
}

type LegacyV3Backing = {
	kind: "v3";
	importedUsage: Usage;
	baselineWrites: readonly CommittedWrite[];
};

type JsonlBacking = { kind: "v4" } | LegacyV3Backing;

/** JSONL storage backed by an injected filesystem capability. */
export class JsonlStorage implements Storage {
	private readonly fileSystem: FileSystem;
	private readonly path: string;
	private readonly now: () => number;
	readonly header: JsonlStorageHeader;
	private backing: JsonlBacking;
	private readonly storageState = new InMemoryStorageState();
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	private constructor(options: JsonlStorageOptions, header: JsonlStorageHeader, backing: JsonlBacking) {
		this.fileSystem = options.fileSystem;
		this.path = options.path;
		this.now = options.now ?? Date.now;
		this.header = header;
		this.backing = backing;
	}

	static async create(
		options: JsonlStorageOptions,
		header: JsonlStorageHeader,
		initialWrites: Write[],
		context: Context,
	): Promise<JsonlStorage> {
		const storage = new JsonlStorage(options, header, { kind: "v4" });
		const prepared = storage.storageState.prepareCommit(initialWrites, storage.now());
		const transactions = prepared.writes.length === 0 ? [] : [prepared.writes];
		await publishFileAtomically(options.fileSystem, options.path, serializeStorage(header, transactions), context);
		storage.storageState.applyValidated(prepared.writes);
		return storage;
	}

	/** Atomically create storage from a complete prepared snapshot. */
	static async createFromForkSnapshot(
		options: JsonlStorageOptions,
		header: JsonlStorageHeader,
		snapshot: ForkDestinationSnapshot,
		context: Context,
	): Promise<JsonlStorage> {
		const writes = forkSnapshotWrites(snapshot);
		const snapshotHeader = { ...header, nextSeq: snapshot.nextSeq };
		await publishFileAtomically(
			options.fileSystem,
			options.path,
			serializeStorage(
				snapshotHeader,
				writes.map((write) => [write]),
			),
			context,
		);
		return JsonlStorage.open(options, context);
	}

	static async open(options: JsonlStorageOptions, context: Context): Promise<JsonlStorage> {
		const content = fileValue(
			await options.fileSystem.readTextFile(options.path, context),
			`Failed to read JSONL storage ${options.path}`,
		);
		const { lines, torn } = splitCompleteLines(content);
		if (lines[0] === undefined || lines[0] === "") {
			throw new Error(`Invalid JSONL storage ${options.path}: missing header`);
		}
		const parsedHeader = parseJsonlSessionHeader(lines[0]);
		if (!parsedHeader.ok) {
			throw new Error(`Invalid JSONL storage ${options.path}: invalid header`, { cause: parsedHeader.error });
		}
		if (parsedHeader.value.format === "v3-legacy") {
			return JsonlStorage.openLegacyV3(options, parsedHeader.value.header, lines.slice(1), context);
		}

		const header = parsedHeader.value.header;
		if (header.storageVersion !== JSONL_STORAGE_VERSION) {
			throw new Error(`Session ${header.id} uses unsupported storage version ${header.storageVersion}`);
		}
		const storage = new JsonlStorage(options, header, { kind: "v4" });
		for (let index = 1; index < lines.length; index++) {
			const line = lines[index]!;
			try {
				storage.replayCommitted(parseTransaction(line));
			} catch (error) {
				throw new Error(`Invalid JSONL storage ${options.path}: line ${index + 1}`, { cause: error });
			}
		}
		if (header.nextSeq !== undefined) storage.storageState.advanceNextSeq(header.nextSeq);
		if (torn) await publishFileAtomically(options.fileSystem, options.path, `${lines.join("\n")}\n`, context);
		return storage;
	}

	private static async openLegacyV3(
		options: JsonlStorageOptions,
		header: LegacyV3SessionHeader,
		recordLines: readonly string[],
		context: Context,
	): Promise<JsonlStorage> {
		const { writes, importedUsage, nextSeq } = normalizeLegacyV3Records(recordLines);
		const targetHeader = {
			...(await normalizeLegacyV3Header(options.fileSystem, header, context)),
			nextSeq,
		};
		const storage = new JsonlStorage(options, targetHeader, {
			kind: "v3",
			importedUsage,
			baselineWrites: writes,
		});
		storage.replayCommitted(writes);
		return storage;
	}

	private replayCommitted(writes: readonly CommittedWrite[]): void {
		this.storageState.validateCommitted(writes);
		this.storageState.applyValidated(writes);
	}

	async commit(writes: Write[], context: Context): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		const result = this.commitQueue.then(() => this.applyCommit(writes, context));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async applyCommit(writes: Write[], context: Context): Promise<CommitResult> {
		if (this.backing.kind === "v3" && writes.length !== 0) {
			return this.upgradeLegacyV3ToV4(this.backing, writes, context);
		}
		const prepared = this.storageState.prepareCommit(writes, this.now());
		if (prepared.writes.length !== 0) {
			fileValue(
				await this.fileSystem.appendFile(this.path, `${serializeTransaction(prepared.writes)}\n`, context),
				`Failed to append JSONL storage ${this.path}`,
			);
		}
		const stats = this.storageState.applyValidated(prepared.writes);
		return { ...prepared.result, stats: this.withImportedUsage(stats) };
	}

	/** Atomically upgrade legacy v3 backing and preserve the first caller write as a v4 transaction. */
	private async upgradeLegacyV3ToV4(
		backing: LegacyV3Backing,
		callerWrites: Write[],
		context: Context,
	): Promise<CommitResult> {
		const timestamp = this.now();
		const prepared = this.storageState.prepareCommit(
			[
				insertUsage({
					id: uuidv7(timestamp),
					usage: backing.importedUsage,
					adjustment: true,
					details: { source: "v3-import" },
				}),
				...callerWrites,
			],
			timestamp,
		);

		const nextSeq = prepared.result.firstSeq + prepared.writes.length;
		const upgradedHeader = { ...this.header, nextSeq };
		await publishFileAtomically(
			this.fileSystem,
			this.path,
			serializeStorage(upgradedHeader, [...backing.baselineWrites.map((write) => [write]), prepared.writes]),
			context,
		);

		const stats = this.storageState.applyValidated(prepared.writes);
		this.backing = { kind: "v4" };
		// The first sequence belongs to the internal usage adjustment; return only caller-write sequences.
		return {
			...prepared.result,
			firstSeq: prepared.result.firstSeq + 1,
			seqs: prepared.result.seqs.slice(1),
			stats,
		};
	}

	getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.getEntries(ids));
	}

	getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.getValue(address));
	}

	scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.scanValues(prefix));
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		_context: Context,
	): Promise<ListElement<T>[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.storageState.readList(address, options);
	}

	async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.storageState.scanBranch(query);
	}

	async scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.storageState.scanBranchStructure(query);
	}

	scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.scanEntries(query));
	}

	scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.scanUsage(query));
	}

	getStats(_context: Context): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.withImportedUsage(this.storageState.getStats()));
	}

	private withImportedUsage(stats: SessionStats): SessionStats {
		return this.backing.kind === "v4" ? stats : { ...stats, usage: this.backing.importedUsage };
	}

	/** Capture the state needed to fork at one serialized boundary between commits. */
	captureForkSource(_context: Context): Promise<ForkSourceSnapshot> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		const result = this.commitQueue.then(() => this.storageState.snapshotEntriesAndValues());
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	close(_context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}
}
