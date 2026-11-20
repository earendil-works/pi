// A local socket in a private directory: a lock and a channel at once, and the data directory's sockets with what
// the command asks over them. Only the directory's owner can make a socket
// file in it (directories are 0700, `files.ts`), so whoever answers on one is a process of the owner's: no token and no
// proof travels. The server's (`server.sock`) and the supervisor's (`supervisor.sock`) answer the command's
// requests, one JSON line each way; a session worker's (`locks/<hash>`) answers nothing and only keeps a second
// worker of the session from opening its store. On Windows the socket is a named pipe named after the path. A
// holder's socket ends with its process; a socket file a killed holder left behind answers nobody and is removed by
// the next taker.
// A socket path holds at most 108 bytes on Linux and 104 on macOS: the runner names a session's lock by a short hash
// (`<data directory>/locks/<hash>`), not inside the worker's directory, whose session id alone is 36 characters.

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";

/** A held socket: `release` closes it and removes its file (the process's exit does too). */
export type HeldSocket = { release(): Promise<void> };

/** What a held socket answers a request with: one JSON value each way. */
export type Answer = (request: unknown) => Promise<unknown>;

/** The outcome of taking a socket: taken, or held by a live process. */
export type Taken = { readonly kind: "taken"; readonly socket: HeldSocket } | { readonly kind: "held" };

/** What the command asks the server: what it is, to stop, or to run one of the plugins' commands. */
export type ServerRequest =
	| { readonly kind: "status" }
	| { readonly kind: "stop" }
	| { readonly kind: "command"; readonly name: string };

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

/** What the server answers a `stop` or a `command`. */
export type ServerAnswer =
	| ServerStatus
	| { readonly kind: "stopping" }
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

/** Takes the socket at `path` and answers each request with `answer`; `held` when a live process holds it. */
export async function takeSocket(path: string, answer?: Answer): Promise<Taken> {
	const address = addressOf(path);
	// Connections a holder does not answer stay open: a waiter learns of the release when its connection closes.
	const open = new Set<Socket>();
	const server = createServer((socket) => {
		open.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => open.delete(socket));
		if (answer !== undefined) answerOn(socket, answer);
	});
	for (;;) {
		if (await listened(server, address)) break;
		if (!(await cleared(path, address))) return { kind: "held" };
	}
	const removeFile = (): void => {
		if (address !== path) return;
		try {
			unlinkSync(path);
		} catch {
			// Gone already.
		}
	};
	process.once("exit", removeFile);
	let released: Promise<void> | undefined;
	const release = (): Promise<void> => {
		released ??= new Promise<void>((resolve) => {
			process.removeListener("exit", removeFile);
			removeFile();
			server.close(() => resolve());
			for (const socket of open) socket.destroy();
		});
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
		await untilClosed(addressOf(path), context);
	}
}

/** A connect's errors that mean nobody holds the socket: no file, a file nobody listens on, or no socket there. */
const NOBODY = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

/** A connection's errors that mean its holder went away before it answered. */
const GONE = new Set(["ECONNRESET", "EPIPE"]);

/**
 * Sends `request` to the holder of the socket at `path`: its answer, or `undefined` when nobody holds it (also a holder
 * that went away before it answered: it released the socket, or died); rejects when it does not answer within `ms`.
 */
export function ask(path: string, request: unknown, ms = 5000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = connect(addressOf(path));
		let text = "";
		socket.setTimeout(ms, () => socket.destroy(new Error(`p3: ${path} did not answer within ${ms} ms`)));
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			text += chunk.toString("utf8");
			const end = text.indexOf("\n");
			if (end < 0) return;
			socket.destroy();
			// A trust boundary: the answer of a process of the owner's (the socket's directory is private).
			resolve(JSON.parse(text.slice(0, end)));
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (NOBODY.has(error.code ?? "") || GONE.has(error.code ?? "")) resolve(undefined);
			else reject(error);
		});
		// After an answer this settles nothing; before one, the holder went away.
		socket.once("close", () => resolve(undefined));
	});
}

/** The server's socket in `dataDir`. */
export function serverSocket(dataDir: string): string {
	return join(dataDir, "server.sock");
}

/** The supervisor's socket in `dataDir`. */
export function supervisorSocket(dataDir: string): string {
	return join(dataDir, "supervisor.sock");
}

/** Where the socket of `path` lives: the path itself, or on Windows a named pipe named after it. */
function addressOf(path: string): string {
	if (process.platform !== "win32") return path;
	return `\\\\.\\pipe\\p3-${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
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
			(value) => socket.end(`${JSON.stringify(value)}\n`),
			(error: unknown) => socket.end(`${JSON.stringify({ kind: "failed", error: String(error) })}\n`),
		);
	});
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
 * Removes the socket file at `path` when nobody answers on it (a killed holder left it): whether the address is free
 * to try again. A named pipe ends with its holder: in use, it is held. The file is removed only while it is still the
 * one found dead: a taker that removed it meanwhile and listens again made a new one, which another taker must not
 * remove (two takers of one Pi at once are rare; this narrows their race to the moment between `lstat` and `unlink`).
 */
async function cleared(path: string, address: string): Promise<boolean> {
	if (address !== path) return false;
	const found = await lstat(path).catch(() => undefined);
	if (found === undefined) return true;
	if (!(await nobodyAnswers(path))) return false;
	const now = await lstat(path).catch(() => undefined);
	if (now === undefined) return true;
	if (now.ino !== found.ino || now.dev !== found.dev) return false;
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	return true;
}

/** Whether nobody accepts on the socket at `address`. */
function nobodyAnswers(address: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = connect(address);
		socket.once("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => resolve(NOBODY.has(error.code ?? "")));
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
