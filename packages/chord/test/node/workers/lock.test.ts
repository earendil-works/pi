// Tests of process locks (slice 10 §3): one holder at a time, a waiter taking the lock when the holder releases it
// (told by its connection's close, no polling), a waiter's abort, socket files failing closed when stale, and clearing
// a stale one.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { processLock } from "../../../src/node/workers/index.ts";
import { clearStaleLockAt, lockAt } from "../../../src/node/workers/lock.ts";

describe("processLock", () => {
	it("makes a second taker wait until the holder releases, then takes it", async () => {
		const name = `chord-test-lock-${process.pid}-${Date.now()}`;
		const first = await processLock(name, context);
		let taken = false;
		const second = processLock(name, context).then((lock) => {
			taken = true;
			return lock;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(taken).toBe(false);
		const released = Date.now();
		await first.release();
		await (await second).release();
		expect(taken).toBe(true);
		expect(Date.now() - released).toBeLessThan(100);
	});

	it("stops waiting when the waiter's context aborts", async () => {
		const name = `chord-test-lock-abort-${process.pid}-${Date.now()}`;
		const held = await processLock(name, context);
		const abort = new AbortController();
		const waiting = processLock(name, withAbortSignal(abort.signal, context));
		abort.abort(new Error("gave up"));
		await expect(waiting).rejects.toThrow("gave up");
		await held.release();
		await (await processLock(name, context)).release();
	});
});

describe("socket file locks (macOS, the BSDs)", () => {
	it("fail closed on a stale lock file, naming it: two takers never both take it over (Sol)", async () => {
		await inTemporaryDirectory(async (dir) => {
			// What a holder killed without its exit hooks leaves (a socket nobody listens on), and a regular file (ENOTSOCK
			// on macOS: it once made the taker spin until its context ended).
			for (const [name, leave] of [
				["killed.sock", leaveSocketFile],
				["regular.sock", (path: string) => writeFile(path, "")],
			] as const) {
				const address = join(dir, name);
				await leave(address);
				const takers = [lockAt({ kind: "file", address }, context), lockAt({ kind: "file", address }, context)];
				for (const taker of takers) await expect(taker).rejects.toThrow(`lock: ${address} is a stale lock file`);
			}
		});
	});

	it("are taken, waited for and released like the others", async () => {
		await inTemporaryDirectory(async (dir) => {
			const address = join(dir, "lock.sock");
			const first = await lockAt({ kind: "file", address }, context);
			const second = lockAt({ kind: "file", address }, context);
			await first.release();
			await (await second).release();
		});
	});
});

describe("clearStaleLockAt", () => {
	it("removes a socket file nobody accepts on: the lock can be taken again", async () => {
		await inTemporaryDirectory(async (dir) => {
			const address = join(dir, "lock.sock");
			await leaveSocketFile(address);
			expect(await clearStaleLockAt({ kind: "file", address }, context)).toBe(true);
			await (await lockAt({ kind: "file", address }, context)).release();
		});
	});

	it("keeps a held lock's file, and does nothing without a file or for abstract sockets and pipes", async () => {
		await inTemporaryDirectory(async (dir) => {
			const address = join(dir, "lock.sock");
			expect(await clearStaleLockAt({ kind: "file", address }, context)).toBe(false);
			const held = await lockAt({ kind: "file", address }, context);
			expect(await clearStaleLockAt({ kind: "file", address }, context)).toBe(false);
			// Still held: a second taker waits.
			let taken = false;
			const second = lockAt({ kind: "file", address }, context).then((lock) => {
				taken = true;
				return lock;
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(taken).toBe(false);
			await held.release();
			await (await second).release();
			expect(await clearStaleLockAt({ kind: "abstract", address: "\0chord-test-unused" }, context)).toBe(false);
			expect(await clearStaleLockAt({ kind: "pipe", address: "\\\\.\\pipe\\chord-test-unused" }, context)).toBe(
				false,
			);
		});
	});
});

/** Runs `fn` in a fresh temporary directory, removed afterwards whatever `fn` did. */
async function inTemporaryDirectory(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "chord-lock-file-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Leaves a socket file at `path` as a holder killed without its exit hooks does: a process listening there, SIGKILLed. */
async function leaveSocketFile(path: string): Promise<void> {
	const script = `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`;
	const result = spawnSync(process.execPath, ["-e", script]);
	expect(result.signal).toBe("SIGKILL");
}
