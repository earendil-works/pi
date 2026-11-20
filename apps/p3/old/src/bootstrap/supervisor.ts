// The background server's supervisor (`p3` and `p3 restart` start it, detached): it runs the server as its child,
// starts it again after a crash, and ends with it when it stops. One per data directory: it holds the supervisor's
// lock and record (`src/kit/running.ts`), so `p3 stop` finds it also while no server runs between two starts.
// Run: supervisor.ts <dataDir (its real path)> <node's arguments of the server's command...>
//
// The child tells over its IPC channel when it listens. A child that never listened failed its start (a busy port,
// another server on the directory): the supervisor ends with its exit code instead of trying again for ever. A child
// that exits 0 was stopped. Anything else after the listen is a crash.

import { type ChildProcess, spawn } from "node:child_process";
import { openSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { layoutOf } from "../kit/layout.ts";
import { removeRecord, takeLock, writeRecord } from "../kit/running.ts";

/** The wait before a crashed server starts again: 1 s, doubled for each crash in a row, at most 30 s. */
const FIRST_DELAY_MS = 1000;
const LONGEST_DELAY_MS = 30_000;

/** A server that ran this long was no crash in a row: the next wait is the first one again. */
const SETTLED_MS = 60_000;

/**
 * How long a supervisor waits for its lock: a command asking who runs holds it for a moment. A supervisor that lost
 * the directory to another is ended by the command that started it (`src/commands.ts`).
 */
const LOCK_MS = 1000;

const [dataDir, ...command] = process.argv.slice(2);
if (dataDir === undefined || command.length === 0) throw new Error("Usage: supervisor.ts <dataDir> <command...>");

const lock = await takeLock(dataDir, "supervisor", LOCK_MS, context);
if (lock === undefined) process.exit(1);
await writeRecord(dataDir, "supervisor", { state: "starting" });
const { log } = layoutOf(dataDir);
await mkdir(dirname(log), { recursive: true, mode: 0o700 });
// The server prints into the log itself; the supervisor adds what it does.
const out = openSync(log, "a", 0o600);
const say = (text: string): void => void writeSync(out, `${new Date().toISOString()} supervisor: ${text}\n`);

let stopping = false;
let child: ChildProcess | undefined;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopping = true;
		child?.kill("SIGTERM");
		wake?.();
	});
}

let delay = FIRST_DELAY_MS;
let code = 0;
for (;;) {
	const started = Date.now();
	const ended = await run();
	code = ended.code;
	if (stopping || ended.code === 0 || !ended.listened) break;
	if (Date.now() - started >= SETTLED_MS) delay = FIRST_DELAY_MS;
	say(`the server exited with ${ended.code}; starting it again in ${delay} ms`);
	await new Promise<void>((resolve) => {
		wake = resolve;
		setTimeout(resolve, delay);
	});
	if (stopping) {
		code = 0;
		break;
	}
	delay = Math.min(delay * 2, LONGEST_DELAY_MS);
}
await removeRecord(dataDir, "supervisor");
await lock.release();
process.exit(code);

/**
 * Runs the server once: its exit code (1 for a signal), and whether it had listened. Once it listens, the record says
 * `running`: a command that then finds no server knows it crashed.
 */
async function run(): Promise<{ readonly code: number; readonly listened: boolean }> {
	const running = spawn(process.execPath, command, { stdio: ["ignore", out, out, "ipc"], windowsHide: true });
	child = running;
	let recorded: Promise<void> | undefined;
	running.once("message", () => {
		recorded = writeRecord(dataDir, "supervisor", { state: "running" });
	});
	const code = await new Promise<number>((resolve) => {
		running.once("error", (error) => {
			say(`the server did not start: ${error.message}`);
			resolve(1);
		});
		running.once("exit", (exit) => {
			child = undefined;
			resolve(exit ?? 1);
		});
	});
	// Done before the record is removed at the exit, never after it.
	await recorded;
	return { code, listened: recorded !== undefined };
}
