// The background server's supervisor (`p3` and `p3 restart` start it, detached: it leads a process group, which its
// server joins; session workers lead groups of their own): it runs the server as its child, starts it again after a
// crash, and ends with it when it stops. One per data directory: it holds the data directory's `supervisor.sock`
// (`local-socket.ts`), which answers the command (its pid, its server's, a stop), so `p3 stop` finds it also while no
// server runs between two starts.
// Run: supervisor.ts <dataDir> <node's arguments of the server's command...>
//
// The child tells over its IPC channel when it listens. A child that never listened failed its start (a busy port,
// another server on the directory): the supervisor ends with its exit code instead of trying again for ever. A child
// that exits 0 was stopped. Anything else after the listen is a crash (a failed store's server exits 1), and the next
// start waits 1 s, doubled for each crash in a row.

import "./minimum-node.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { fchmodSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { privateDirectory } from "./files.ts";
import { type SupervisorAnswer, supervisorSocket, takeSocket } from "./local-socket.ts";

/** The wait before a crashed server starts again: 1 s, doubled for each crash in a row, at most 30 s. */
const FIRST_DELAY_MS = 1000;
const LONGEST_DELAY_MS = 30_000;

/** A server that ran this long was no crash in a row: the next wait is the first one again. */
const SETTLED_MS = 60_000;

const [dataDir, ...command] = process.argv.slice(2);
if (dataDir !== undefined && command.length > 0) await supervise(dataDir, command);

/** Runs the server `command` on `dataDir` until it is stopped, starting it again after each crash. */
async function supervise(dataDir: string, command: readonly string[]): Promise<void> {
	let stopping = false;
	let child: ChildProcess | undefined;
	let wake: (() => void) | undefined;
	// Ready before the socket answers: a stop asked while the log opens is kept, and no server starts after it.
	const stop = (): void => {
		stopping = true;
		child?.kill("SIGTERM");
		wake?.();
	};
	const taken = await takeSocket(
		supervisorSocket(dataDir),
		BACKGROUND_CONTEXT,
		async (request): Promise<SupervisorAnswer> => {
			// A trust boundary: a request on the socket; only its kind matters.
			const kind =
				typeof request === "object" && request !== null ? (request as { kind?: unknown }).kind : undefined;
			if (kind === "status") return { kind: "supervising", pid: process.pid, server: child?.pid ?? null };
			if (kind !== "stop") return { kind: "invalid" };
			stop();
			return { kind: "stopping" };
		},
	);
	if (taken.kind === "held") process.exit(1);
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
	await privateDirectory(join(dataDir, "logs"));
	// The server prints into the log itself; the supervisor adds what it does. Private also when it existed looser.
	const out = openSync(join(dataDir, "logs", "server.log"), "a", 0o600);
	fchmodSync(out, 0o600);
	const say = (text: string): void => void writeSync(out, `${new Date().toISOString()} supervisor: ${text}\n`);
	let delay = FIRST_DELAY_MS;
	let code = 0;
	while (!stopping) {
		const started = Date.now();
		child = spawn(process.execPath, command, { stdio: ["ignore", out, out, "ipc"], windowsHide: true });
		say(`the server starts (pid ${child.pid})`);
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
		// A stop during the wait: the server was stopped, not crashed.
		if (stopping) code = 0;
		delay = Math.min(delay * 2, LONGEST_DELAY_MS);
	}
	await taken.socket.release();
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
