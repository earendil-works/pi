// Process locks (slice 10 §3, Chord v1's `processLock`): one live worker per address. A lock is a listening socket the
// kernel owns for the holder's lifetime (an abstract socket on Linux and Android, a named pipe on Windows, a socket file
// elsewhere), so there is no race between two would-be holders; a socket file a crashed holder left fails closed (the
// error names it: a takeover would race another taker). A child finding the lock held waits
// without polling: it connects to the holder's socket, which the holder never answers, and tries again when that
// connection closes (the holder exited).

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../../context/index.ts";

/** A held lock: `release` frees it (the process's exit does too). */
export type ProcessLock = { release(): Promise<void> };

/** Where a lock lives: an abstract socket (Linux, Android), a named pipe (Windows) or a socket file (elsewhere). */
export type LockAddress = { readonly kind: "abstract" | "pipe" | "file"; readonly address: string };

/**
 * Takes the lock `name`, waiting while another process holds it (until `context` aborts: rejects with its reason).
 * Throws what listening throws besides "in use", and for a stale socket file (macOS, the BSDs) an error naming it.
 */
export async function processLock(name: string, context: Context): Promise<ProcessLock> {
	const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
	if (process.platform === "win32")
		return lockAt({ kind: "pipe", address: `\\\\.\\pipe\\chord-lock-${key}` }, context);
	if (process.platform === "linux" || process.platform === "android") {
		return lockAt({ kind: "abstract", address: `\0chord-lock-${key}` }, context);
	}
	return lockAt({ kind: "file", address: await socketPath(`chord-lock-${key}.sock`) }, context);
}

/**
 * Takes the lock at `lock`, waiting while it is held. A socket file nobody accepts on (a crashed holder's) fails closed:
 * taking it over races another taker (two could both unlink and listen), so the error names the file to remove.
 */
export async function lockAt(lock: LockAddress, context: Context): Promise<ProcessLock> {
	const { address } = lock;
	const file = lock.kind === "file";
	// Connections are kept open, never answered: a waiter learns of the release when its connection closes.
	const waiters = new Set<Socket>();
	const server = createServer((socket) => {
		waiters.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => waiters.delete(socket));
	});
	for (;;) {
		context.abortSignal?.throwIfAborted();
		if (await listened(server, address)) break;
		const held = await waitWhileHeld(address, context);
		if (!held && file) {
			throw new Error(`lock: ${address} is a stale lock file (no process holds it); remove it if no worker runs`);
		}
	}
	const removeFile = (): void => {
		try {
			unlinkSync(address);
		} catch {
			// Gone already.
		}
	};
	if (file) process.once("exit", removeFile);
	return {
		release: () =>
			new Promise<void>((resolve, reject) => {
				if (file) process.removeListener("exit", removeFile);
				server.close((error) => (error ? reject(error) : resolve()));
				// Waiters see their connections close (and `close` waits for them).
				for (const socket of waiters) socket.destroy();
			}),
	};
}

/** Whether `server` now listens on `address`; `false` when it is in use. */
function listened(server: Server, address: string): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const failed = (error: NodeJS.ErrnoException): void => {
			if (error.code === "EADDRINUSE") resolve(false);
			else reject(error);
		};
		server.once("error", failed);
		server.listen(address, () => {
			server.removeListener("error", failed);
			resolve(true);
		});
	});
}

/**
 * Connects to the holder of `address` and resolves when that connection closes or the address is gone (`true`: try
 * again), or with `false` when nobody accepts on it (a leftover socket file); `context`'s abort rejects.
 */
function waitWhileHeld(address: string, context: Context): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const signal = context.abortSignal;
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const socket = connect(address);
		const abort = (): void => {
			socket.destroy();
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const settle = (held: boolean): void => {
			signal?.removeEventListener("abort", abort);
			resolve(held);
		};
		let connected = false;
		socket.once("connect", () => {
			connected = true;
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (!connected && error.code === "ECONNREFUSED") settle(false);
		});
		socket.once("close", () => settle(true));
	});
}

/** sun_path holds 104 bytes on macOS and the BSDs, the terminating NUL included. */
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * A lock socket's path: in the temporary directory, or, when that does not fit in sun_path (a deep TMPDIR), in a
 * private per-user directory under /tmp that only its owner can reach.
 */
async function socketPath(file: string): Promise<string> {
	const preferred = join(tmpdir(), file);
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
	const uid = process.getuid?.() ?? 0;
	const directory = `/tmp/chord-lock-${uid}`;
	await mkdir(directory, { mode: 0o700, recursive: true });
	const stats = await lstat(directory);
	if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
		throw new Error(`lock directory ${directory} must be a directory only its owner can access`);
	}
	return join(directory, file);
}
