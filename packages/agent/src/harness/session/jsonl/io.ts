import type { Context } from "../../context.ts";
import type { FileError, FileSystem, Result } from "../../types.ts";
import type {
	CommittedEntryWrite,
	CommittedListAppendWrite,
	CommittedListDeleteWrite,
	CommittedUsageWrite,
	CommittedValueDeleteWrite,
	CommittedValueSetWrite,
	CommittedWrite,
} from "../commit.ts";

export function fileValue<T>(result: Result<T, FileError>, action: string): T {
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

export function parseJsonlTransaction(line: string): CommittedWrite[] {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Invalid JSONL transaction: not valid JSON", { cause: error });
	}
	return (Array.isArray(value) ? value : [value]).map(parseCommittedWrite);
}

export function serializeJsonlTransaction(writes: readonly CommittedWrite[]): string {
	return JSON.stringify(writes.length === 1 ? writes[0] : writes);
}

export async function publishFileAtomically(
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
