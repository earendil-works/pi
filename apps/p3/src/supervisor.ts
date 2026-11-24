// The background server's supervisor (`p3` and `p3 restart` start it, detached): it runs the server as its child,
// starts it again after a crash, and ends with it when it stops. One per data directory: it holds the supervisor's
// lock and writes `supervisor-running.json` (its pid), so `p3 stop` finds it also while no server runs between two starts.
// Run: supervisor.ts <dataDir> <node's arguments of the server's command...>
//
// The child tells over its IPC channel when it listens. A child that never listened failed its start (a busy port,
// another server on the directory): the supervisor ends with its exit code instead of trying again for ever. A child
// that exits 0 was stopped. Anything else after the listen is a crash.

import "./minimum-node.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { openSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/workers/child";
import { privateDirectory, writePrivate } from "./files.ts";
import { supervisorFile, supervisorLock } from "./records.ts";

/** The wait before a crashed server starts again: 1 s, doubled for each crash in a row, at most 30 s. */
const FIRST_DELAY_MS = 1000;
const LONGEST_DELAY_MS = 30_000;

/** A server that ran this long was no crash in a row: the next wait is the first one again. */
const SETTLED_MS = 60_000;

const [dataDir, ...command] = process.argv.slice(2);
if (dataDir !== undefined && command.length > 0) await supervise(dataDir, command);

/** Runs the server `command` on `dataDir` until it is stopped, starting it again after each crash. */
async function supervise(dataDir: string, command: readonly string[]): Promise<void> {
	const lock = await processLock(supervisorLock(dataDir), withAbortSignal(AbortSignal.timeout(1000), context)).catch(
		() => undefined,
	);
	if (lock === undefined) process.exit(1);
	await writePrivate(supervisorFile(dataDir), JSON.stringify({ pid: process.pid }));
	await privateDirectory(join(dataDir, "logs"));
	// The server prints into the log itself; the supervisor adds what it does.
	const out = openSync(join(dataDir, "logs", "server.log"), "a", 0o600);
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
		child = spawn(process.execPath, command, { stdio: ["ignore", out, out, "ipc"] });
		const ended = await runOnce(child, say);
		child = undefined;
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
	await rm(supervisorFile(dataDir), { force: true });
	await lock.release();
	process.exit(code);
}

/** Waits for `child` to exit: its exit code (1 for a signal or a failed spawn), and whether it had listened. */
async function runOnce(
	child: ChildProcess,
	say: (text: string) => void,
): Promise<{ readonly code: number; readonly listened: boolean }> {
	let listened = false;
	child.once("message", () => {
		listened = true;
	});
	const code = await new Promise<number>((resolve) => {
		child.once("error", (error) => {
			say(`the server did not start: ${error.message}`);
			resolve(1);
		});
		child.once("exit", (exit) => resolve(exit ?? 1));
	});
	return { code, listened };
}
