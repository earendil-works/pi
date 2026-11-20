// Who runs on a data directory. A server writes `server.json` the moment it holds the data directory's lock (`starting`:
// its pid and its process's start time), again once it listens and its owner link is ready (`running`: its Pi's id,
// port, version and start time), and removes it at a clean exit; the background server's supervisor does the same
// with `supervisor.json`. A crash leaves the file behind, so nobody trusts a file alone: each process also holds a
// lock named after the data directory for as long as it lives, and a record counts only while its lock is held and its
// pid is still the process that wrote it (a pid the system gave to another process since has another start time).

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import { type ProcessLock, processLock } from "@earendil-works/chord/workers";
import { ifExists } from "./layout.ts";
import { writeSecret } from "./secrets.ts";

/**
 * Which process wrote a record: its pid and when it started (`processStart`), so a reused pid is not taken for it.
 * `start` is missing where the writer could not learn its own (no `ps`, as on Windows): such a record names nobody.
 */
export type ProcessId = { readonly pid: number; readonly start?: string };

/**
 * What a server says of itself in `server.json`: starting (it holds the lock), then running (it listens). `run` is
 * random, made at each start: the server that listens proves it is this record's by answering it (`identity.ts`).
 */
export type ServerState =
	| { readonly state: "starting"; readonly run: string }
	| {
			readonly state: "running";
			readonly run: string;
			/** The Pi's id (`pi.json`). */
			readonly pi: string;
			readonly port: number;
			readonly version: string;
			/** When it listened, in ms since the epoch. */
			readonly startedAt: number;
	  };

/**
 * What a supervisor says of itself in `supervisor.json`: its server's state (`starting`: its first server has not
 * listened yet; `running`: it has, so a supervisor without a server is starting it again after a crash).
 */
export type SupervisorState = { readonly state: "starting" | "running" };

/** A server's record. */
export type ServerRecord = ProcessId & ServerState;

/** A supervisor's record. */
export type SupervisorRecord = ProcessId & SupervisorState;

/** The two processes of a data directory, each with its lock and its record. */
export type Role = "server" | "supervisor";

type StateOf<R extends Role> = R extends "server" ? ServerState : SupervisorState;

/** The record of `R`. */
export type RecordOf<R extends Role> = ProcessId & StateOf<R>;

/** The file of `role`'s record in the data directory `dataDir`. */
export function recordFile(dataDir: string, role: Role): string {
	return join(dataDir, `${role}.json`);
}

/**
 * Takes `role`'s lock on `dataDir` (its real path: a second process, also through a symbolic link, would share what
 * the first owns), waiting at most `wait` ms for a holder to go; `undefined` when it is still held then.
 */
export async function takeLock(
	dataDir: string,
	role: Role,
	wait: number,
	context: Context,
): Promise<ProcessLock | undefined> {
	const waited = AbortSignal.timeout(wait);
	try {
		return await processLock(`p3-${role}:${dataDir}`, withAbortSignal(waited, context));
	} catch (error) {
		if (waited.aborted) return undefined;
		throw error;
	}
}

/** Writes `role`'s record into `dataDir` for this process (its pid and start time added), in one step. */
export async function writeRecord<R extends Role>(dataDir: string, role: R, state: StateOf<R>): Promise<void> {
	// Without its own start time a record still says what the holder does; it names nobody (`holder`).
	const start = await processStart(process.pid);
	const record = { pid: process.pid, ...(start === undefined ? {} : { start }), ...state };
	await writeSecret(recordFile(dataDir, role), JSON.stringify(record), "replace");
}

/** Removes `role`'s record from `dataDir`: its holder exits. */
export async function removeRecord(dataDir: string, role: Role): Promise<void> {
	await rm(recordFile(dataDir, role), { force: true });
}

/**
 * Who holds `role`'s lock on a data directory: nobody (`free`), a process that has not said who it is yet, whose
 * record is an earlier holder's, or whose identity cannot be proven (`unnamed`: nothing is signalled, nothing read
 * from its record), or the process its record names (`named`).
 */
export type Holder<R extends Role> =
	| { readonly kind: "free" }
	| { readonly kind: "unnamed" }
	| { readonly kind: "named"; readonly record: RecordOf<R> }
	| (R extends "server" ? Claimed : never);

/**
 * A server's record that says `running`, the lock held: believed only once the server on the record's port answers
 * the record's run id (the commands ask it). A process start time proves nothing here: a pid or a port another program
 * has by now would pass it, a listening server answers for itself.
 */
export type Claimed = { readonly kind: "claimed"; readonly record: Running };

/** A server's record once it listens. */
export type Running = ProcessId & Extract<ServerState, { readonly state: "running" }>;

/** How long `holder` waits behind a lock's holder before it calls the lock held (a free lock is taken at once). */
const HELD_MS = 20;

/**
 * Who holds `role`'s lock on `dataDir`. A record is believed only while the lock is held: a running server's is
 * `claimed`, to be proven by asking the server; any other only while its pid is still the process that wrote it: the
 * same start time, both known (two unknown ones prove nothing). A record nobody holds the lock for is removed.
 */
export async function holder<R extends Role>(dataDir: string, role: R, context: Context): Promise<Holder<R>> {
	const lock = await takeLock(dataDir, role, HELD_MS, context);
	if (lock !== undefined) {
		// Nobody holds it: whatever record is there is stale. Removed under the lock, so never a starting holder's.
		await removeRecord(dataDir, role);
		await lock.release();
		return { kind: "free" };
	}
	// No file: the holder has not written it yet, or just left. A record of another process: a crashed holder's, which
	// the new one has not replaced yet (its pid may be another process's by now).
	const text = await ifExists(readFile(recordFile(dataDir, role), "utf8"));
	const record = text === undefined ? undefined : (JSON.parse(text) as RecordOf<R>);
	// A trust boundary: a file. Its pid goes into a command line (PowerShell's), its port into a request.
	if (record === undefined || !Number.isSafeInteger(record.pid) || record.pid <= 0) return { kind: "unnamed" };
	if (role === "server" && record.state === "running") {
		// TypeScript does not narrow `R` by `role`: a claimed holder is a server's, as the check above says.
		return { kind: "claimed", record: record as Running } as Holder<R>;
	}
	if (record.start === undefined || (await processStart(record.pid)) !== record.start) return { kind: "unnamed" };
	return { kind: "named", record };
}

const run = promisify(execFile);

/** How long a lookup of a process's start may take (PowerShell starts slowly). */
const START_MS = 10_000;

/**
 * When process `pid` started, as text that only that process has; `undefined` when it cannot be learnt (no such
 * process, or no way to ask), which never proves an identity. On Linux and Android the start time in clock ticks since
 * boot (`/proc/<pid>/stat`); on Windows what PowerShell says, in UTC and its round-trip format; elsewhere what `ps`
 * says, to the second, in UTC.
 */
export async function processStart(pid: number): Promise<string | undefined> {
	if (process.platform === "linux" || process.platform === "android") {
		const stat = await ifExists(readFile(`/proc/${pid}/stat`, "utf8"));
		// The fields after the command's name, which is in parentheses and may hold anything: the start is field 22.
		return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	}
	// Both answer for one fixed time zone and format, whoever asks: the text must be the same for every command.
	const [command, args] =
		process.platform === "win32"
			? [
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
					],
				]
			: ["ps", ["-o", "lstart=", "-p", String(pid)]];
	try {
		const env = { ...process.env, TZ: "UTC", LC_ALL: "C" };
		const { stdout } = await run(command, args, { env, timeout: START_MS, windowsHide: true });
		return stdout.trim() || undefined;
	} catch {
		// No such process (both exit 1), no `ps` or PowerShell, or one that hung: unknown either way.
		return undefined;
	}
}
