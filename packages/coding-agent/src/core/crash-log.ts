import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, VERSION } from "../config.ts";

export interface CrashRecord {
	timestamp: string;
	version: string;
	kind: "uncaught_exception" | "fatal_error";
	message: string;
	stack: string | null;
	sessionFile: string | null;
	cwd: string;
	notified?: boolean;
}

const MAX_CRASH_RECORDS = 5;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function crashLogPath(agentDir = getAgentDir()): string {
	return join(agentDir, "crashes.json");
}

export function readCrashLog(path = crashLogPath()): CrashRecord[] {
	try {
		const records: unknown = JSON.parse(readFileSync(path, "utf8"));
		return Array.isArray(records)
			? records.filter(
					(record): record is CrashRecord =>
						typeof record === "object" &&
						record !== null &&
						typeof (record as CrashRecord).timestamp === "string" &&
						typeof (record as CrashRecord).message === "string",
				)
			: [];
	} catch {
		return [];
	}
}

function writeCrashLog(records: readonly CrashRecord[], path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
}

/** Best-effort persistence for callers that are already crashing. */
export function recordCrash(
	crash: { kind: CrashRecord["kind"]; error: unknown; sessionFile?: string; cwd: string },
	path = crashLogPath(),
): CrashRecord | undefined {
	try {
		const { error } = crash;
		const record: CrashRecord = {
			timestamp: new Date().toISOString(),
			version: VERSION,
			kind: crash.kind,
			message: error instanceof Error ? error.message || error.name : String(error),
			stack: error instanceof Error && error.stack ? error.stack : null,
			sessionFile: crash.sessionFile ?? null,
			cwd: crash.cwd,
		};
		writeCrashLog([...readCrashLog(path), record].slice(-MAX_CRASH_RECORDS), path);
		return record;
	} catch {
		return undefined;
	}
}

/** Return the newest recent crash, marking pending records as announced. */
export function takeUnnotifiedCrash(path = crashLogPath(), now = Date.now()): CrashRecord | undefined {
	const records = readCrashLog(path);
	const crash = [...records]
		.reverse()
		.find((record) => !record.notified && now - Date.parse(record.timestamp) <= MAX_AGE);
	if (!crash) return undefined;
	try {
		writeCrashLog(
			records.map((record) => (record.notified ? record : { ...record, notified: true })),
			path,
		);
	} catch {
		// Showing the notice again is harmless.
	}
	return crash;
}

export function clearCrashLog(path = crashLogPath()): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// The records can be attached again if cleanup fails.
	}
}
