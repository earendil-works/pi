// A local socket in a private directory: a lock and a channel at once, and the data directory's sockets with what
// the command asks over them. The server's (`server.sock`) and the supervisor's (`supervisor.sock`) answer the
// command's requests, one JSON line each way; a session worker's (`locks/<hash>`) answers nothing and only keeps a
// second worker of the session from opening its store. A holder's socket ends with its process; a socket file a killed
// holder left behind answers nobody and is replaced by the next taker.
//
// The trust boundary is the OS user: only the directory's owner can make a socket file in it or connect to one
// (directories are 0700, `files.ts`), so whoever answers on one is a process of the owner's, and every process of the
// owner's user may ask (the owner's programs, plugins, an agent's tools): no token and no proof travels. That holds on
// POSIX only. On Windows the socket is a named pipe named after the path, in a namespace every local user shares, so
// neither end is authenticated there yet (ERNDL-1059).
//
// Taking a socket file: the taker listens on a temporary name in the same directory, then, under a short guard (Chord's
// `processLock`, a lock the kernel owns: an abstract socket on Linux and Android), looks at the path and renames its
// socket into place unless a live holder answers there. Two takers of a killed holder's file therefore cannot both
// win. A release removes the file only while it is still its own (same inode): libuv removes the name it listened on,
// the temporary one, never the path. Elsewhere the guard is a socket file in the temporary directory, and one a crash
// left while holding it fails the next take, naming the file. An abstract name is visible to every local user: one
// could hold a Pi's guard and keep its takers waiting, never take its socket (the file stays in the private
// directory).
//
// A socket path holds at most 108 bytes on Linux and Android and 103 on macOS and the BSDs: `checkSocketPaths` refuses
// a data directory too long for its sockets, the longest of which is a session's lock (`locks/<16 hex>`, named so by
// the runner plugin: the session id alone is 36 characters).

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { lstat, rename } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/workers/child";

/** A held socket: `release` closes it and removes its file (the process's exit does too). */
export type HeldSocket = { release(): Promise<void> };

/** What a held socket answers a request with: one JSON value each way. */
export type Answer = (request: unknown) => Promise<unknown>;

/** The outcome of taking a socket: taken, or held by a live process. */
export type Taken = { readonly kind: "taken"; readonly socket: HeldSocket } | { readonly kind: "held" };

/** What the command asks the server: what it is, or to run one of the plugins' commands (`stop`, `apply`, ...). */
export type ServerRequest = { readonly kind: "status" } | { readonly kind: "command"; readonly name: string };

/** What the server answers its `status`: still starting (no port yet), or running. */
export type ServerStatus =
	| { readonly kind: "starting"; readonly pid: number }
	| {
			readonly kind: "running";
			readonly pid: number;
			readonly port: number;
			readonly version: string;
			/** When it listened, in ms since the epoch. */
			readonly startedAt: number;
	  };

/** What the server answers a `command`, or a request it does not know. */
export type ServerAnswer =
	| ServerStatus
	| { readonly kind: "answer"; readonly value: unknown }
	| { readonly kind: "unknown"; readonly name: string }
	| { readonly kind: "failed"; readonly error: string }
	| { readonly kind: "invalid" };

/** What the command asks the supervisor. */
export type SupervisorRequest = { readonly kind: "status" } | { readonly kind: "stop" };

/** What the supervisor answers. */
export type SupervisorAnswer =
	/** `server`: its server's pid while one runs. */
	| { readonly kind: "supervising"; readonly pid: number; readonly server: number | null }
	| { readonly kind: "stopping" }
	| { readonly kind: "invalid" };

/** What asking a holder gave: no holder, a holder that did not answer in time (hung), or its answer. */
export type Reply<A> =
	| { readonly kind: "none" }
	| { readonly kind: "silent" }
	| { readonly kind: "answered"; readonly answer: A };

/** Takes the socket at `path` and answers each request with `answer`; `held` when a live process holds it. */
export async function takeSocket(path: string, answer?: Answer): Promise<Taken> {
	checkSocketPath(path);
	// Connections a holder does not answer stay open: a waiter learns of the release when its connection closes.
	const open = new Set<Socket>();
	const server = createServer((socket) => {
		open.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => open.delete(socket));
		if (answer !== undefined) answerOn(socket, answer);
	});
	if (process.platform === "win32") {
		if (!(await listened(server, pipeOf(path)))) return { kind: "held" };
		return { kind: "taken", socket: { release: () => closed(server, open) } };
	}
	const own = await placed(server, open, path);
	if (own === undefined) return { kind: "held" };
	const removeOwn = (): void => {
		try {
			const now = lstatSync(path);
			if (now.ino === own.ino && now.dev === own.dev) unlinkSync(path);
		} catch {
			// Gone already.
		}
	};
	process.once("exit", removeOwn);
	let released: Promise<void> | undefined;
	const release = (): Promise<void> => {
		released ??= (async () => {
			process.removeListener("exit", removeOwn);
			removeOwn();
			await closed(server, open);
		})();
		return released;
	};
	return { kind: "taken", socket: { release } };
}

/** Waits until no live process holds the socket at `path`, then takes it, answering nothing; an abort rejects. */
export async function waitForSocket(path: string, context: Context): Promise<HeldSocket> {
	for (;;) {
		context.abortSignal?.throwIfAborted();
		const taken = await takeSocket(path);
		if (taken.kind === "taken") return taken.socket;
		await untilClosed(process.platform === "win32" ? pipeOf(path) : path, context);
	}
}

/**
 * Sends `request` to the holder of the socket at `path`: its answer, or `undefined` when nobody holds it (also a holder
 * that went away before it answered: it released the socket, or died); rejects when it does not answer within `ms`.
 */
export async function ask(path: string, request: unknown, ms = ASK_MS): Promise<unknown> {
	const reply = await exchange(path, request, ms);
	if (reply.kind === "silent") throw new Error(`p3: ${path} did not answer within ${ms} ms`);
	return reply.kind === "answered" ? reply.answer : undefined;
}

/** How long a holder gets to answer by default. */
export const ASK_MS = 5000;

/** Asks the server on `dataDir`; an answer of a shape p3 does not know rejects. */
export async function askServer(dataDir: string, request: ServerRequest, ms: number): Promise<Reply<ServerAnswer>> {
	const path = join(dataDir, "server.sock");
	const reply = await exchange(path, request, ms);
	if (reply.kind !== "answered") return reply;
	// A trust boundary: the answer of a process of the owner's; its pids are signalled, so they are checked.
	if (!isServerAnswer(reply.answer)) throw new Error(`p3: ${path} answered ${shown(reply.answer)}`);
	return { kind: "answered", answer: reply.answer };
}

/** Asks the supervisor on `dataDir`; an answer of a shape p3 does not know rejects. */
export async function askSupervisor(
	dataDir: string,
	request: SupervisorRequest,
	ms: number,
): Promise<Reply<SupervisorAnswer>> {
	const path = join(dataDir, "supervisor.sock");
	const reply = await exchange(path, request, ms);
	if (reply.kind !== "answered") return reply;
	// A trust boundary, as in `askServer`.
	if (!isSupervisorAnswer(reply.answer)) throw new Error(`p3: ${path} answered ${shown(reply.answer)}`);
	return { kind: "answered", answer: reply.answer };
}

/** The server's socket in `dataDir`. */
export function serverSocket(dataDir: string): string {
	return join(dataDir, "server.sock");
}

/** The supervisor's socket in `dataDir`. */
export function supervisorSocket(dataDir: string): string {
	return join(dataDir, "supervisor.sock");
}

/** Throws unless the sockets of the data directory `dataDir` fit this system's socket paths. */
export function checkSocketPaths(dataDir: string): void {
	// The runner names a session's lock by 16 hex digits: the longest socket path of a Pi.
	for (const name of ["server.sock", "supervisor.sock", join("locks", "0".repeat(16))]) {
		checkSocketPath(join(dataDir, name));
	}
}

/** The longest socket path this system binds, in bytes: 108 on Linux and Android (measured), 103 elsewhere. */
export const MAX_SOCKET_PATH_BYTES = process.platform === "linux" || process.platform === "android" ? 108 : 103;

/** Throws unless `path` fits a socket path (no limit for Windows' pipes, which are named by a hash). */
function checkSocketPath(path: string): void {
	const bytes = Buffer.byteLength(path);
	if (process.platform === "win32" || bytes <= MAX_SOCKET_PATH_BYTES) return;
	throw new Error(
		`p3: the socket path ${path} is ${bytes} bytes, longer than the ${MAX_SOCKET_PATH_BYTES} this system allows; use a data directory with a shorter path`,
	);
}

/**
 * `server` listening on a temporary name beside `path`, renamed into place under the guard unless a live process
 * holds `path`: the identity of the file it placed, or `undefined` (held; `server` closed again, ending `open`).
 */
async function placed(
	server: Server,
	open: ReadonlySet<Socket>,
	path: string,
): Promise<{ readonly ino: number; readonly dev: number } | undefined> {
	let temporary: string;
	do temporary = join(dirname(path), `.${randomBytes(9).toString("base64url")}`);
	while (!(await listened(server, temporary)));
	// Held for a look and a rename. A crash meanwhile leaves the guard free (the kernel owns it on Linux and Android)
	// and at most the temporary file, which nobody takes.
	const guard = await processLock(`p3-socket:${path}`, BACKGROUND_CONTEXT);
	try {
		if (await heldAt(path)) {
			await closed(server, open);
			return undefined;
		}
		const own = await lstat(temporary);
		// Replaces a killed holder's file at once: no moment without a socket at the path, nobody else's removed.
		await rename(temporary, path);
		return own;
	} catch (error) {
		await closed(server, open);
		throw error;
	} finally {
		await guard.release();
	}
}

/** Whether a live process holds the socket file at `path`; a file there that is no socket is refused, not removed. */
async function heldAt(path: string): Promise<boolean> {
	const found = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (found === undefined) return false;
	if (!found.isSocket()) throw new Error(`p3: ${path} is not a socket; remove it if no p3 runs there`);
	return new Promise<boolean>((resolve, reject) => {
		const socket = connect(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
			else reject(error);
		});
	});
}

/** Closes `server` (libuv removes the name it listened on) and ends its open connections. */
function closed(server: Server, open: ReadonlySet<Socket>): Promise<void> {
	return new Promise<void>((resolve) => {
		server.close(() => resolve());
		for (const socket of open) socket.destroy();
	});
}

/** The named pipe of `path` on Windows. */
function pipeOf(path: string): string {
	return `\\\\.\\pipe\\p3-${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
}

/** A connect's errors that mean nobody holds the socket: no file, a file nobody listens on, or no socket there. */
const NOBODY = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

/** A connection's errors that mean its holder went away before it answered. */
const GONE = new Set(["ECONNRESET", "EPIPE"]);

/** Sends `request` to the holder at `path` and reads its answer within `ms` (at least 1 ms: 0 would disable the timeout). */
function exchange(path: string, request: unknown, ms: number): Promise<Reply<unknown>> {
	return new Promise((resolve, reject) => {
		const socket = connect(process.platform === "win32" ? pipeOf(path) : path);
		let text = "";
		socket.setTimeout(Math.max(1, ms), () => {
			resolve({ kind: "silent" });
			socket.destroy();
		});
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			text += chunk.toString("utf8");
			const end = text.indexOf("\n");
			if (end < 0) return;
			socket.destroy();
			// A trust boundary: the answer of a process of the owner's (the socket's directory is private).
			try {
				resolve({ kind: "answered", answer: JSON.parse(text.slice(0, end)) });
			} catch {
				reject(new Error(`p3: ${path} answered no JSON`));
			}
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (NOBODY.has(error.code ?? "") || GONE.has(error.code ?? "")) resolve({ kind: "none" });
			else reject(error);
		});
		// After an answer this settles nothing; before one, the holder went away.
		socket.once("close", () => resolve({ kind: "none" }));
	});
}

/** Reads one JSON line from `socket`, writes `answer`'s answer as one line, and ends it. */
function answerOn(socket: Socket, answer: Answer): void {
	let text = "";
	socket.on("data", (chunk) => {
		text += chunk.toString("utf8");
		const end = text.indexOf("\n");
		if (end < 0) return;
		socket.removeAllListeners("data");
		// A trust boundary: a request of a process of the owner's; `answer` checks its shape.
		let request: unknown;
		try {
			request = JSON.parse(text.slice(0, end));
		} catch {
			socket.end(`${JSON.stringify({ kind: "invalid" })}\n`);
			return;
		}
		answer(request).then(
			(value) => socket.end(`${lineOf(value)}\n`),
			(error: unknown) => socket.end(`${lineOf({ kind: "failed", error: String(error) })}\n`),
		);
	});
}

/** `value` as one JSON line, or a `failed` answer when it is no JSON (a plugin's command answered a cycle, a BigInt). */
function lineOf(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch (error) {
		return JSON.stringify({ kind: "failed", error: `the answer is no JSON: ${String(error)}` });
	}
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

/** Resolves once a connection to the holder at `address` closes (the holder released or exited), or none could open. */
function untilClosed(address: string, context: Context): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const socket = connect(address);
		const aborted = (): void => {
			socket.destroy();
			reject(context.abortSignal?.reason);
		};
		context.abortSignal?.addEventListener("abort", aborted, { once: true });
		socket.on("error", () => {});
		socket.once("close", () => {
			context.abortSignal?.removeEventListener("abort", aborted);
			resolve();
		});
	});
}

/** Whether `value` is one of the server's answers, its pids and port numbers that can be. */
function isServerAnswer(value: unknown): value is ServerAnswer {
	const answer = value as Record<string, unknown> | null;
	if (typeof answer !== "object" || answer === null) return false;
	switch (answer.kind) {
		case "starting":
			return isPid(answer.pid);
		case "running":
			return (
				isPid(answer.pid) &&
				Number.isInteger(answer.port) &&
				(answer.port as number) > 0 &&
				(answer.port as number) <= 65535 &&
				typeof answer.version === "string" &&
				typeof answer.startedAt === "number"
			);
		case "answer":
			return Object.hasOwn(answer, "value");
		case "unknown":
			return typeof answer.name === "string";
		case "failed":
			return typeof answer.error === "string";
		case "invalid":
			return true;
		default:
			return false;
	}
}

/** Whether `value` is one of the supervisor's answers, its pids ones that can be. */
function isSupervisorAnswer(value: unknown): value is SupervisorAnswer {
	const answer = value as Record<string, unknown> | null;
	if (typeof answer !== "object" || answer === null) return false;
	if (answer.kind === "supervising") return isPid(answer.pid) && (answer.server === null || isPid(answer.server));
	return answer.kind === "stopping" || answer.kind === "invalid";
}

/** Whether `value` can be another process's pid: an integer above 1 (never 0, -1 or init, which `kill` reads apart). */
function isPid(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 1;
}

/** `value` for an error message, at most 200 characters. */
function shown(value: unknown): string {
	return JSON.stringify(value).slice(0, 200);
}
