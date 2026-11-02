import type { OutboxCommit } from "@earendil-works/chord/next";

/**
 * Version of the line envelope. It changes when the envelope changes; the writes inside carry the store outbox's own
 * `format`, which `applyBatch()` checks.
 */
export const LOG_VERSION = 2;

type LogLine = {
	readonly v: typeof LOG_VERSION;
	readonly seq: number;
	readonly nextId: number;
	readonly writes: OutboxCommit["writes"];
};

export class LogFormatError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LogFormatError";
	}
}

/** One outbox commit as a JSON line, terminated by a newline. */
export function encodeLogLine(commit: OutboxCommit): string {
	const line: LogLine = { v: LOG_VERSION, seq: commit.seq, nextId: commit.nextId, writes: commit.writes };
	return `${JSON.stringify(line)}\n`;
}

/**
 * Decode JSON lines. A last line without its newline is a torn append and is returned as `torn` instead of a commit;
 * anything else that does not decode is an error. A line of an unknown version is an error too: an older pi must not
 * apply writes it does not understand. The writes themselves are checked by `applyBatch()`, a trust boundary.
 */
export function decodeLogLines(text: string): { readonly commits: OutboxCommit[]; readonly torn: number } {
	const commits: OutboxCommit[] = [];
	let start = 0;
	let previous = 0;
	while (start < text.length) {
		const end = text.indexOf("\n", start);
		if (end === -1) return { commits, torn: text.length - start };
		const commit = decodeLine(text.slice(start, end), commits.length + 1);
		if (commit.seq <= previous) {
			throw new LogFormatError(`Log line ${commits.length + 1} does not increase the sequence`);
		}
		previous = commit.seq;
		commits.push(commit);
		start = end + 1;
	}
	return { commits, torn: 0 };
}

function decodeLine(text: string, number: number): OutboxCommit {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new LogFormatError(`Log line ${number} is not JSON`, { cause: error });
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LogFormatError(`Log line ${number} is not an object`);
	}
	const line = value as Partial<LogLine> & { readonly v?: unknown };
	if (line.v !== LOG_VERSION) throw new LogFormatError(`Log line ${number} has unknown version ${String(line.v)}`);
	if (typeof line.seq !== "number" || !Number.isSafeInteger(line.seq) || line.seq < 1) {
		throw new LogFormatError(`Log line ${number} has no valid sequence`);
	}
	if (typeof line.nextId !== "number" || !Number.isSafeInteger(line.nextId)) {
		throw new LogFormatError(`Log line ${number} has no valid next id`);
	}
	if (!Array.isArray(line.writes)) throw new LogFormatError(`Log line ${number} has no writes`);
	return { seq: line.seq, nextId: line.nextId, writes: line.writes };
}
