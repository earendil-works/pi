import type { Context } from "../../context.ts";
import type { FileSystem, TextLineReader } from "../../types.ts";
import type {
	CommittedEntryWrite,
	CommittedListAppendWrite,
	CommittedValueSetWrite,
	CommittedWrite,
} from "../commit.ts";
import { type ForkCurrentStatePlan, projectForkCurrentStateWrite, selectBranchFork } from "../fork-policy.ts";
import type { ForkOptions } from "../types.ts";
import { parseJsonlSessionHeader } from "./codec.ts";
import { fileValue, parseJsonlTransaction, serializeJsonlTransaction } from "./io.ts";
import { JSONL_STORAGE_VERSION, type JsonlStorageHeader } from "./types.ts";

interface JsonlForkSourceMetadata {
	id: string;
	cwd: string;
	path: string;
}

function physicalKey(namespace: string, key: string): string {
	return `${namespace}\u0000${key}`;
}

async function readJsonlForkHeader(
	reader: TextLineReader,
	source: JsonlForkSourceMetadata,
	context: Context,
): Promise<JsonlStorageHeader> {
	const line = fileValue(await reader.readLine(context), `Failed to read JSONL fork source ${source.path}`);
	if (line === undefined || !line.terminated || line.text === "") {
		throw new Error(`Invalid JSONL storage ${source.path}: missing header`);
	}
	const parsed = parseJsonlSessionHeader(line.text);
	if (!parsed.ok || parsed.value.format !== "v4") {
		throw new Error(`Invalid JSONL storage ${source.path}: expected format 4 header`, {
			cause: parsed.ok ? undefined : parsed.error,
		});
	}
	const header = parsed.value.header;
	if (header.id !== source.id || header.cwd !== source.cwd) {
		throw new Error(`Session identity does not match header: ${source.id}`);
	}
	if (header.storageVersion !== JSONL_STORAGE_VERSION) {
		throw new Error(`Session ${source.id} uses unsupported storage version ${header.storageVersion}`);
	}
	return header;
}

function reachesForkBoundary(writes: readonly CommittedWrite[], stopBeforeSeq: number | undefined): boolean {
	if (stopBeforeSeq === undefined || writes.length === 0) return false;
	const first = writes[0]!;
	const last = writes.at(-1)!;
	if (first.seq >= stopBeforeSeq) return true;
	if (last.seq >= stopBeforeSeq) {
		throw new Error(`JSONL transaction crosses fork sequence boundary ${stopBeforeSeq}`);
	}
	return false;
}

async function scanJsonlForkTransactions(
	fileSystem: FileSystem,
	source: JsonlForkSourceMetadata,
	stopBeforeSeq: number | undefined,
	onTransaction: (writes: readonly CommittedWrite[]) => void | Promise<void>,
	context: Context,
): Promise<{ header: JsonlStorageHeader; highestCompleteSeq: number }> {
	const reader = fileValue(
		await fileSystem.openTextLineReader(source.path, context),
		`Failed to open JSONL fork source ${source.path}`,
	);
	try {
		const header = await readJsonlForkHeader(reader, source, context);
		let highestCompleteSeq = 0;
		while (true) {
			const line = fileValue(await reader.readLine(context), `Failed to read JSONL fork source ${source.path}`);
			if (line === undefined || !line.terminated) break;
			const writes = parseJsonlTransaction(line.text);
			if (reachesForkBoundary(writes, stopBeforeSeq)) break;
			if (writes.length !== 0) highestCompleteSeq = writes.at(-1)!.seq;
			await onTransaction(writes);
		}
		return { header, highestCompleteSeq };
	} finally {
		await reader.close(context);
	}
}

class JsonlForkIndex {
	private readonly currentScalarSeqs = new Map<string, number>();
	private readonly branchTips = new Map<string, string | null>();
	private readonly firstSurvivingListSeqs = new Map<string, number>();
	private readonly entryParents = new Map<string, string | null>();
	private readonly copiedEntryIds = new Set<string>();
	private readonly laneConfigs = new Set<string>();
	private readonly laneStates = new Set<string>();

	applyWrites(writes: readonly CommittedWrite[]): void {
		for (const write of writes) {
			switch (write.kind) {
				case "entry":
					this.entryParents.set(write.id, write.parentId);
					break;
				case "value": {
					const key = physicalKey(write.namespace, write.key);
					if (write.op === "delete") {
						this.currentScalarSeqs.delete(key);
					} else {
						this.currentScalarSeqs.set(key, write.seq);
					}
					this.applyLaneValue(write);
					break;
				}
				case "list": {
					const key = physicalKey(write.namespace, write.key);
					if (write.op === "delete") this.firstSurvivingListSeqs.delete(key);
					else if (!this.firstSurvivingListSeqs.has(key)) this.firstSurvivingListSeqs.set(key, write.seq);
					break;
				}
				case "usage":
					break;
			}
		}
	}

	private applyLaneValue(write: Extract<CommittedWrite, { kind: "value" }>): void {
		const present = write.op === "set";
		switch (write.namespace) {
			case "pi.branch.tip":
				if (present) this.branchTips.set(write.key, write.value as string | null);
				else this.branchTips.delete(write.key);
				break;
			case "pi.lane.config":
				if (present) this.laneConfigs.add(write.key);
				else this.laneConfigs.delete(write.key);
				break;
			case "pi.lane.state":
				if (present) this.laneStates.add(write.key);
				else this.laneStates.delete(write.key);
				break;
		}
	}

	getBranchTip(branch: string): string | null | undefined {
		return this.branchTips.get(branch);
	}

	getCurrentScalarSeq(namespace: string, key: string): number | undefined {
		return this.currentScalarSeqs.get(physicalKey(namespace, key));
	}

	isSurvivingListElement(namespace: string, key: string, seq: number): boolean {
		const firstSeq = this.firstSurvivingListSeqs.get(physicalKey(namespace, key));
		return firstSeq !== undefined && seq >= firstSeq;
	}

	getParent(entryId: string): string | null | undefined {
		return this.entryParents.get(entryId);
	}

	selectEntry(entryId: string): void {
		this.copiedEntryIds.add(entryId);
	}

	isEntrySelected(entryId: string): boolean {
		return this.copiedEntryIds.has(entryId);
	}

	validateLanes(options: ForkOptions): void {
		for (const lane of new Set([...this.branchTips.keys(), ...this.laneConfigs, ...this.laneStates])) {
			this.validateLane(lane);
		}
		if (options.scope === "branch" && !this.laneConfigs.has(options.branch)) {
			throw new Error(`Source branch ${JSON.stringify(options.branch)} is not a configured AgentLane`);
		}
	}

	private validateLane(lane: string): void {
		const hasTip = this.branchTips.has(lane);
		const hasConfiguration = this.laneConfigs.has(lane);
		const hasState = this.laneStates.has(lane);
		if (!hasTip && (hasConfiguration || hasState)) {
			throw new Error(`Source session branch ${JSON.stringify(lane)} is missing branch.tip`);
		}
		if (hasConfiguration !== hasState) {
			throw new Error(`Source session branch ${JSON.stringify(lane)} has incomplete lane state`);
		}
		const tip = this.branchTips.get(lane);
		if (tip !== undefined && tip !== null && !this.entryParents.has(tip)) {
			throw new Error(`Source session branch ${JSON.stringify(lane)} has an unknown tip`);
		}
	}
}

function selectJsonlFork(index: JsonlForkIndex, options: ForkOptions): ForkCurrentStatePlan {
	index.validateLanes(options);
	if (options.scope === "tree") return { scope: "tree" };
	return selectBranchFork(options, {
		tip: index.getBranchTip(options.branch),
		getParent: (entryId) => index.getParent(entryId),
		selectEntry: (entryId) => index.selectEntry(entryId),
	});
}

class JsonlForkWriter {
	private readonly fileSystem: FileSystem;
	private readonly destinationPath: string;
	private readonly tempPath: string;

	private constructor(fileSystem: FileSystem, destinationPath: string) {
		this.fileSystem = fileSystem;
		this.destinationPath = destinationPath;
		this.tempPath = `${destinationPath}.tmp`;
	}

	static async create(
		fileSystem: FileSystem,
		destinationPath: string,
		header: JsonlStorageHeader,
		context: Context,
	): Promise<JsonlForkWriter> {
		const writer = new JsonlForkWriter(fileSystem, destinationPath);
		try {
			fileValue(
				await fileSystem.writeFile(writer.tempPath, `${JSON.stringify(header)}\n`, context),
				`Failed to stage JSONL storage ${destinationPath}`,
			);
			return writer;
		} catch (error) {
			await writer.discard(context);
			throw error;
		}
	}

	async append(write: JsonlForkWrite, context: Context): Promise<void> {
		fileValue(
			await this.fileSystem.appendFile(this.tempPath, `${serializeJsonlTransaction([write])}\n`, context),
			`Failed to append JSONL fork destination ${this.destinationPath}`,
		);
	}

	async publish(context: Context): Promise<void> {
		fileValue(
			await this.fileSystem.renameFile(this.tempPath, this.destinationPath, context),
			`Failed to publish JSONL storage ${this.destinationPath}`,
		);
	}

	async discard(context: Context): Promise<void> {
		await this.fileSystem.remove(this.tempPath, { force: true }, context);
	}
}

type JsonlForkWrite = CommittedEntryWrite | CommittedValueSetWrite | CommittedListAppendWrite;

function projectJsonlForkWrite(
	write: CommittedWrite,
	index: JsonlForkIndex,
	plan: ForkCurrentStatePlan,
	isEntryCopied: (entryId: string) => boolean,
): JsonlForkWrite | undefined {
	switch (write.kind) {
		case "entry":
			return isEntryCopied(write.id) ? write : undefined;
		case "value":
			if (write.op !== "set") return undefined;
			if (index.getCurrentScalarSeq(write.namespace, write.key) !== write.seq) return undefined;
			return projectForkCurrentStateWrite(write, plan, isEntryCopied);
		case "list":
			if (write.op !== "append") return undefined;
			if (!index.isSurvivingListElement(write.namespace, write.key, write.seq)) return undefined;
			return projectForkCurrentStateWrite(write, plan, isEntryCopied);
		case "usage":
			return undefined;
	}
}

export type JsonlForkSource =
	| { kind: "open"; metadata: JsonlForkSourceMetadata; nextSeq: number }
	| { kind: "closed"; metadata: JsonlForkSourceMetadata };

export async function runJsonlFork(
	options: {
		source: JsonlForkSource;
		fileSystem: FileSystem;
		destinationPath: string;
		destinationHeader: Omit<JsonlStorageHeader, "nextSeq">;
		fork: ForkOptions;
	},
	context: Context,
): Promise<void> {
	const index = new JsonlForkIndex();
	const firstPass = await scanJsonlForkTransactions(
		options.fileSystem,
		options.source.metadata,
		options.source.kind === "open" ? options.source.nextSeq : undefined,
		(writes) => index.applyWrites(writes),
		context,
	);
	const nextSeq =
		options.source.kind === "open"
			? options.source.nextSeq
			: Math.max(firstPass.header.nextSeq ?? 1, firstPass.highestCompleteSeq + 1);
	const plan = selectJsonlFork(index, options.fork);
	const isEntryCopied = (entryId: string): boolean => {
		if (plan.scope === "tree") return true;
		return index.isEntrySelected(entryId);
	};
	const writer = await JsonlForkWriter.create(
		options.fileSystem,
		options.destinationPath,
		{ ...options.destinationHeader, nextSeq },
		context,
	);
	try {
		await scanJsonlForkTransactions(
			options.fileSystem,
			options.source.metadata,
			nextSeq,
			async (writes) => {
				for (const write of writes) {
					const projected = projectJsonlForkWrite(write, index, plan, isEntryCopied);
					if (projected !== undefined) await writer.append(projected, context);
				}
			},
			context,
		);
		await writer.publish(context);
	} catch (error) {
		await writer.discard(context);
		throw error;
	}
}
