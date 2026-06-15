import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Opt-in diagnostic for the held-open-pipe case. Enable with PI_STDIO_DEBUG=1.
 *
 * When a child exits but a detached descendant keeps emitting on the inherited
 * stdout/stderr pipe, we keep reading (re-arming the grace on each chunk) rather
 * than truncate the tail. A descendant that writes continuously can therefore
 * hold the wait open until the command's own timeout kills the tree. That is the
 * right trade-off, but it is otherwise invisible: the command reads as a slow
 * hang with no indication that the process itself had already exited. This flag
 * surfaces the case so it can be diagnosed instead of guessed at.
 */
const STDIO_DEBUG = process.env.PI_STDIO_DEBUG === "1";

export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a fixed deadline measured
 * from `exit`, or output still being written past that deadline is silently lost
 * (earendil-works/pi#5303). Instead, after `exit` we wait for the pipes to fall idle:
 * the grace timer is re-armed on every chunk, so an actively writing descendant keeps
 * us reading, while a quiet inherited handle (e.g. a Windows daemonized descendant
 * that never lets `close` fire) still releases us after the grace elapses.
 *
 * Set PI_STDIO_DEBUG=1 to log when a process exits but keeps emitting output past
 * exit (see {@link STDIO_DEBUG}).
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		// Diagnostics for the held-open-pipe case (only collected under PI_STDIO_DEBUG).
		let exitedAt = 0;
		let postExitChunks = 0;
		let postExitBytes = 0;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null, reason: "eof" | "idle-grace" | "close") => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			// Only the held-open case is worth a line: the process had already exited
			// yet kept emitting, which is what can stretch a command to its timeout.
			if (STDIO_DEBUG && exited && postExitChunks > 0) {
				console.error(
					`[stdio] pid ${child.pid ?? "?"} exited but held stdio open for ${Date.now() - exitedAt}ms past exit ` +
						`(${postExitChunks} chunk(s), ${postExitBytes}B read after exit; resolved via ${reason})`,
				);
			}
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode, "eof");
			}
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode, "idle-grace"), EXIT_STDIO_GRACE_MS);
		};

		const onData = (chunk: Buffer) => {
			// Output is still arriving after exit; defer finalizing so we don't
			// destroy the stream mid-write and truncate the tail.
			if (exited && !settled) {
				if (STDIO_DEBUG) {
					postExitChunks += 1;
					postExitBytes += chunk.length;
				}
				armIdleTimer();
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			if (STDIO_DEBUG) exitedAt = Date.now();
			maybeFinalizeAfterExit();
			if (!settled) {
				armIdleTimer();
			}
		};

		const onClose = (code: number | null) => {
			finalize(code, "close");
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
