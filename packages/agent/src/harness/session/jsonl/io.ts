import type { Context } from "../../context.ts";
import type { FileError, FileSystem, Result, TextLineReader } from "../../types.ts";
import type {
	CommittedEntryWrite,
	CommittedListAppendWrite,
	CommittedListDeleteWrite,
	CommittedUsageWrite,
	CommittedValueDeleteWrite,
	CommittedValueSetWrite,
	CommittedWrite,
} from "../commit.ts";
import { type JsonlParsedSessionHeader, parseJsonlSessionHeader } from "./codec.ts";
import type { JsonlStorageHeader } from "./types.ts";

export function fileValue<T>(result: Result<T, FileError>, action: string): T {
	if (!result.ok) throw new Error(`${action}: ${result.error.message}`, { cause: result.error });
	return result.value;
}

export async function readJsonlHeader(
	reader: TextLineReader,
	path: string,
	context: Context,
): Promise<JsonlParsedSessionHeader> {
	const line = fileValue(await reader.readLine(context), `Failed to read JSONL storage ${path}`);
	if (line === undefined || !line.terminated || line.text === "") {
		throw new Error(`Invalid JSONL storage ${path}: missing header`);
	}
	const parsed = parseJsonlSessionHeader(line.text);
	if (!parsed.ok) {
		throw new Error(`Invalid JSONL storage ${path}: invalid header`, { cause: parsed.error });
	}
	return parsed.value;
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

/** Publish only after the callback succeeds; it must await each append before returning. */
export async function publishFileAtomically(
	fileSystem: FileSystem,
	destinationPath: string,
	context: Context,
	writeContent: (append: (content: string) => Promise<void>) => Promise<void>,
): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		fileValue(await fileSystem.writeFile(tempPath, "", context), `Failed to stage JSONL storage ${destinationPath}`);
		await writeContent(async (content) => {
			fileValue(
				await fileSystem.appendFile(tempPath, content, context),
				`Failed to append JSONL storage ${destinationPath}`,
			);
		});
		fileValue(
			await fileSystem.renameFile(tempPath, destinationPath, context),
			`Failed to publish JSONL storage ${destinationPath}`,
		);
	} catch (error) {
		await fileSystem.remove(tempPath, { force: true }, context);
		throw error;
	}
}

/** Stream a header and complete transactions through the shared atomic publisher. */
export async function publishJsonl(
	fileSystem: FileSystem,
	destinationPath: string,
	header: JsonlStorageHeader,
	context: Context,
	writeTransactions: (append: (writes: readonly CommittedWrite[]) => Promise<void>) => Promise<void>,
): Promise<void> {
	await publishFileAtomically(fileSystem, destinationPath, context, async (append) => {
		await append(`${JSON.stringify(header)}\n`);
		await writeTransactions((writes) => append(`${serializeJsonlTransaction(writes)}\n`));
	});
}
