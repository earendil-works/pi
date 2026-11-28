// Process locks (slice 10 §3; decision "Process locks are kernel locks on macOS and the BSDs"): one live holder per
// name, held by a kernel object that ends with the holder, so nothing is ever cleared. Linux and Android: an abstract
// socket; Windows: a named pipe. macOS and the BSDs have neither, and a socket file outlives a holder killed by a
// signal, so there the lock is an exclusive flock on a directory per name, with a socket in it that only wakes waiters.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "../../context/index.ts";

/** A held lock: `release` frees it (the process's exit does too). */
export type ProcessLock = { release(): Promise<void> };

/** Whether a process holds a lock at the moment it was read. */
export type ProcessLockState = "held" | "free";

/** Where a lock lives on this platform; `legacy` is the previous release's socket file of the same lock. */
type LockAddress =
	| { readonly kind: "abstract"; readonly address: string }
	| { readonly kind: "pipe"; readonly address: string; readonly pipe: string }
	| {
			readonly kind: "flock";
			readonly base: string;
			readonly directory: string;
			readonly address: string;
			readonly legacy: string;
	  };

/** A lock directory opened with a flock, or why not. */
type Opened = { readonly kind: "open"; readonly fd: number } | { readonly kind: "held" } | { readonly kind: "gone" };

/** What a take holds besides its listening socket. */
type Taken = { readonly kind: "socket" } | { readonly kind: "flock"; readonly fd: number; readonly directory: string };

const FIRST_PAUSE_MS = 1;
const LAST_PAUSE_MS = 100;

/**
 * A connect nobody accepts on macOS and the BSDs: a take between its flock and its listen, a dead holder's socket
 * closed before the kernel freed its flock, or a full backlog. Paused on, never taken for "free".
 */
const UNREACHABLE = new Set(["ENOENT", "ECONNREFUSED", "EAGAIN", "ENOTSOCK"]);

/**
 * Linux's full backlog (a stopped or busy holder): paused on. Any other failed connect is taken again at once, as with
 * the socket-file locks, which keeps a handover fast.
 */
const FULL_BACKLOG = new Set(["EAGAIN"]);

/**
 * Takes the lock `name`, waiting while another process holds it (until `context` aborts: rejects with its reason).
 * Throws what the take throws besides "held": a lock base that is not this user's own, a socket path too long.
 */
export async function processLock(name: string, context: Context): Promise<ProcessLock> {
	context.abortSignal?.throwIfAborted();
	const lock = await lockAddress(name);
	// Connections are kept open, never answered: a waiter learns of the release when its connection closes.
	const waiters = new Set<Socket>();
	const server = createServer((socket) => {
		waiters.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => waiters.delete(socket));
	});
	let pause = FIRST_PAUSE_MS;
	for (;;) {
		context.abortSignal?.throwIfAborted();
		const taken =
			lock.kind === "flock"
				? await takeDirectory(lock, server)
				: (await listened(server, lock.address))
					? ({ kind: "socket" } as const)
					: undefined;
		if (taken !== undefined) {
			const held = holding(server, waiters, lock, taken);
			if (lock.kind === "flock") await legacyGone(lock.legacy, context).catch(releasing(held));
			return held;
		}
		const waited = await waitWhileHeld(lock.address, lock.kind === "flock" ? UNREACHABLE : FULL_BACKLOG, context);
		// On the flock platforms an unknown connect error (a directory nobody may search) would fail every try at once.
		if (waited.kind === "failed" && lock.kind === "flock") throw waited.error;
		if (waited.kind !== "unreachable") {
			pause = FIRST_PAUSE_MS;
			continue;
		}
		await sleep(pause, context);
		pause = Math.min(pause * 2, LAST_PAUSE_MS);
	}
}

/** Windows' pipe namespace: a named pipe is listed exactly while its holder listens. */
const PIPES = "\\\\.\\pipe\\";

/** Whether a process holds the lock `name`, read without taking it. */
export async function processLockState(name: string, context: Context): Promise<ProcessLockState> {
	context.abortSignal?.throwIfAborted();
	const lock = await lockAddress(name);
	context.abortSignal?.throwIfAborted();
	switch (lock.kind) {
		case "flock":
			return directoryState(lock);
		case "pipe":
			// Never a connect: libuv's wait for a busy pipe (up to 30 s) cannot be cancelled and keeps the process alive.
			return readdirSync(PIPES).includes(lock.pipe) ? "held" : "free";
		case "abstract":
			return socketState(lock.address, context);
	}
}

/** Where the lock `name` lives on this platform. */
async function lockAddress(name: string): Promise<LockAddress> {
	const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
	if (process.platform === "win32")
		return { kind: "pipe", address: `${PIPES}chord-lock-${key}`, pipe: `chord-lock-${key}` };
	if (process.platform === "linux" || process.platform === "android") {
		return { kind: "abstract", address: `\0chord-lock-${key}` };
	}
	if (!["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform)) {
		throw new Error(`processLock: no process locks on ${process.platform}`);
	}
	// Never under `TMPDIR`: it differs between a terminal, launchd, cron and `env -i`, and so would the lock.
	const base = process.platform === "darwin" ? join(await darwinUserTemp(), "chord-lock") : `/tmp/chord-lock-${uid()}`;
	const directory = join(base, key);
	const address = join(directory, "s.sock");
	if (Buffer.byteLength(address) > MAX_SOCKET_PATH_BYTES) {
		throw new Error(`processLock: the socket path ${address} is longer than ${MAX_SOCKET_PATH_BYTES} bytes`);
	}
	return { kind: "flock", base, directory, address, legacy: legacySocket(key) };
}

/** A process value, not a cache an owner could drop: asked once, a failure kept (no fallback to `TMPDIR`). */
let userTemp: Promise<string> | undefined;

/** macOS's per-user temporary directory, private to the user whatever the environment. */
function darwinUserTemp(): Promise<string> {
	userTemp ??= promisify(execFile)("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).then(
		({ stdout }) => {
			const said = stdout.trim();
			// A trust boundary: another program's output.
			if (!said.startsWith("/")) throw new Error(`processLock: getconf DARWIN_USER_TEMP_DIR said "${said}"`);
			return said;
		},
	);
	return userTemp;
}

function uid(): number {
	return process.getuid?.() ?? 0;
}

/** Takes the flock on `lock`'s directory and listens on its socket, or `undefined` while another process holds it. */
async function takeDirectory(
	lock: Extract<LockAddress, { kind: "flock" }>,
	server: Server,
): Promise<Taken | undefined> {
	for (;;) {
		makeDirectory(lock.base);
		privateBase(lock.base);
		makeDirectory(lock.directory);
		const opened = openDirectory(lock.directory, EXCLUSIVE);
		if (opened.kind === "held") return undefined;
		if (opened.kind === "gone") continue;
		const { fd } = opened;
		try {
			// A release removes the directory: this open may have locked a removed one while another process locks a new
			// one at the same path.
			if (!sameDirectory(fd, lock.directory)) {
				closeSync(fd);
				continue;
			}
			// A holder killed by a signal left its socket file; only the flock's owner binds here.
			removeFile(lock.address);
			if (!(await listened(server, lock.address))) {
				throw new Error(`processLock: ${lock.address} was made by another process`);
			}
			return { kind: "flock", fd, directory: lock.directory };
		} catch (error) {
			closeSync(fd);
			throw error;
		}
	}
}

/** Makes `path` (0700) unless it exists; not `recursive`, whose `stat` fails when a release removes it meanwhile. */
function makeDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		// A trust boundary: Node's file system errors.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/** Refuses a lock base another user could have made: not a directory of this user's alone. */
function privateBase(base: string): void {
	const stats = lstatSync(base);
	if (!stats.isDirectory() || stats.uid !== uid() || (stats.mode & 0o077) !== 0) {
		throw new Error(`processLock: ${base} must be a directory only its owner can access`);
	}
}

/** `<sys/fcntl.h>`'s flock flags, the same on macOS and the BSDs; Node's `fs.constants` lacks them. */
const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;

const EXCLUSIVE = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | O_EXLOCK;

function openDirectory(path: string, flags: number): Opened {
	try {
		// libuv opens close-on-exec: a child never keeps its holder's lock.
		return { kind: "open", fd: openSync(path, flags) };
	} catch (error) {
		// A trust boundary: Node's file system errors.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EAGAIN") return { kind: "held" };
		if (code === "ENOENT") return { kind: "gone" };
		throw error;
	}
}

/** Whether the descriptor `fd` is still the directory `path` names (exported for its unit test only). */
export function sameDirectory(fd: number, path: string): boolean {
	const open = fstatSync(fd, { bigint: true });
	try {
		const named = lstatSync(path, { bigint: true });
		return named.ino === open.ino && named.dev === open.dev;
	} catch (error) {
		// A trust boundary: Node's file system errors.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function removeFile(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		// A trust boundary: Node's file system errors.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * The held lock. Its release closes the socket while the flock is still owned (libuv removes the socket file then),
 * removes the directory, frees the flock, and only then closes the waiters' connections, so the first takes at once.
 */
function holding(server: Server, waiters: Set<Socket>, lock: LockAddress, taken: Taken): ProcessLock {
	const tidy =
		taken.kind === "flock"
			? (): void => {
					removeFile(lock.address);
					removeDirectory(taken.directory);
				}
			: undefined;
	if (tidy !== undefined) process.once("exit", tidy);
	// Published before anything can call back in: a second release would close a descriptor number reused meanwhile.
	let released: Promise<void> | undefined;
	return {
		release: () => {
			if (released !== undefined) return released;
			const done = Promise.withResolvers<void>();
			released = done.promise;
			try {
				if (tidy !== undefined) process.removeListener("exit", tidy);
				server.close((error) => (error ? done.reject(error) : done.resolve()));
				if (taken.kind === "flock") {
					removeDirectory(taken.directory);
					closeSync(taken.fd);
				}
				// Waiters see their connections close (and `close` waits for them).
				for (const socket of waiters) socket.destroy();
			} catch (error) {
				done.reject(error);
			}
			return released;
		},
	};
}

/** Removes the lock's directory unless a killed holder's socket file still fills it. */
function removeDirectory(path: string): void {
	try {
		rmdirSync(path);
	} catch {
		// Gone, or not empty.
	}
}

/** LEGACY (one release): the old socket file's connect errors that mean nobody of the previous release is there. */
const LEGACY_NOBODY = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]);

/** LEGACY (one release): resolves once no process of the previous release accepts on `legacy`; removes nothing. */
async function legacyGone(legacy: string, context: Context): Promise<void> {
	for (;;) {
		const waited = await waitWhileHeld(legacy, LEGACY_NOBODY, context);
		if (waited.kind === "unreachable") return;
		if (waited.kind === "failed") throw waited.error;
	}
}

/** LEGACY (one release): gives the flock back when the legacy wait fails, then rethrows. */
function releasing(held: ProcessLock): (error: unknown) => Promise<never> {
	return async (error) => {
		await held.release();
		throw error;
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

/** How a wait for a holder ended. */
type Waited =
	| { readonly kind: "closed" }
	| { readonly kind: "unreachable" }
	| { readonly kind: "failed"; readonly error: NodeJS.ErrnoException };

/**
 * Connects to the holder of `address` and resolves `closed` when that connection closes, `unreachable` for one of
 * `nobody`'s connect errors, `failed` for another; `context`'s abort rejects. On Windows a connect to a busy pipe
 * waits in libuv (`WaitNamedPipeW`, up to 30 s) and `destroy` does not cancel it: an abort rejects at once, but the
 * process may not exit before the pipe frees or the 30 s pass.
 */
function waitWhileHeld(address: string, nobody: ReadonlySet<string>, context: Context): Promise<Waited> {
	return new Promise<Waited>((resolve, reject) => {
		const signal = context.abortSignal;
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const socket = connect(address);
		// `net.client.socket`'s subscribers run inside `connect` and may have aborted.
		if (signal?.aborted) {
			socket.destroy();
			reject(signal.reason);
			return;
		}
		const abort = (): void => {
			socket.destroy();
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const settle = (waited: Waited): void => {
			signal?.removeEventListener("abort", abort);
			resolve(waited);
		};
		let connected = false;
		socket.once("connect", () => {
			connected = true;
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (connected) return;
			// A holder that released while this connect was queued resets it.
			if (error.code === "ECONNRESET") settle({ kind: "closed" });
			else settle(nobody.has(error.code ?? "") ? { kind: "unreachable" } : { kind: "failed", error });
		});
		socket.once("close", () => settle({ kind: "closed" }));
	});
}

function sleep(ms: number, context: Context): Promise<void> {
	return new Promise((resolve, reject) => {
		const signal = context.abortSignal;
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

const SHARED = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | O_SHLOCK;

/** A shared flock taken and dropped: it fails only while a holder has the exclusive one. */
function directoryState(lock: Extract<LockAddress, { kind: "flock" }>): ProcessLockState {
	try {
		privateBase(lock.base);
	} catch (error) {
		// A trust boundary: Node's file system errors.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "free";
		throw error;
	}
	const opened = openDirectory(lock.directory, SHARED);
	switch (opened.kind) {
		case "held":
			return "held";
		case "gone":
			return "free";
		case "open":
			closeSync(opened.fd);
			return "free";
	}
}

/** A connect: a full backlog (`EAGAIN`) is a holder; a reset (`ECONNRESET`) is one that released meanwhile. */
function socketState(address: string, context: Context): Promise<ProcessLockState> {
	return new Promise((resolve, reject) => {
		const signal = context.abortSignal;
		const socket = connect(address);
		// `net.client.socket`'s subscribers run inside `connect` and may have aborted.
		if (signal?.aborted) {
			socket.destroy();
			reject(signal.reason);
			return;
		}
		const abort = (): void => {
			socket.destroy();
			reject(signal?.reason);
		};
		const settle = (state: ProcessLockState): void => {
			signal?.removeEventListener("abort", abort);
			socket.destroy();
			resolve(state);
		};
		signal?.addEventListener("abort", abort, { once: true });
		socket.once("connect", () => settle("held"));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EAGAIN") settle("held");
			else if (error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "ECONNRESET") {
				settle("free");
			} else {
				signal?.removeEventListener("abort", abort);
				reject(error);
			}
		});
	});
}

/** sun_path holds 104 bytes on macOS and the BSDs, the terminating NUL included. */
const MAX_SOCKET_PATH_BYTES = 103;

/** LEGACY (one release, `docs/slices.md`): the previous release's socket file of the lock `key`. */
function legacySocket(key: string): string {
	const file = `chord-lock-${key}.sock`;
	const preferred = join(tmpdir(), file);
	return Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES ? preferred : join(`/tmp/chord-lock-${uid()}`, file);
}
