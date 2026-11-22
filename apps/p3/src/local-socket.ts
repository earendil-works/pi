// The data directory's sockets: `server.sock` and `supervisor.sock` are each a lock and the command's channel (one JSON
// line each way), what the command asks over them, and how one is taken.
//
// The trust boundary is the OS user: the directory is 0700 (`files.ts`), so only the owner's user can make a socket
// file in it or connect to one; whoever answers is a process of the owner's, and every process of that user may ask.
// No token travels. POSIX only: p3 refuses to run on Windows (ERNDL-1059).
//
// Taking a socket file (D8): the taker listens on a temporary name in the same directory, then, under a short guard
// (Chord's `processLock`), renames it into place unless a live holder answers at the path: two takers of a killed
// holder's file cannot both win, and there is no moment without a socket at the path. A release removes the file only
// while it is still its own (same inode). On Linux and Android the guard is an abstract socket, which any local user
// can hold: the wait for it has a deadline and says so, never takes the socket (the file stays in the private
// directory). Elsewhere it is a file in the temporary directory (ERNDL-1059). A taker killed between its listen and its
// rename leaves its temporary file (a dot-file with a random name) in the data directory: inert (nobody listens on
// it, nobody takes it, it grants nothing) and left there, never swept by name: another starter's live temporary file
// looks the same.
//
// The data directory being private is what makes its sockets the owner's: the start checks the directory and its
// immediate parent only (`files.ts`), not every ancestor (ERNDL-1059).

import { randomBytes } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { lstat, rename } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/workers/child";

/** A held socket: `release` closes it and removes its file (the process's exit does too). */
export type HeldSocket = { release(): Promise<void> };

/** What a held socket answers a request with: one JSON value each way. */
export type Answer = (request: unknown) => Promise<unknown>;

/** The outcome of taking a socket: taken, or held by a live process. */
export type Taken = { readonly kind: "taken"; readonly socket: HeldSocket } | { readonly kind: "held" };

/** What the command asks the server: what it is, or to run one of the plugins' commands (`stop`, `apply`, ...). */
export type ServerRequest = { readonly kind: "status" } | { readonly kind: "command"; readonly name: string };

/**
 * What the server answers its `status`: still starting (no port yet), or running. `workers`: the pids of its session
 * workers' processes, each the leader of a process group of its own (`p3 stop`'s kill ends them too).
 */
export type ServerStatus =
	| { readonly kind: "starting"; readonly pid: number; readonly workers: readonly number[] }
	| {
			readonly kind: "running";
			readonly pid: number;
			readonly workers: readonly number[];
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

/** A reply that is no answer: no holder, or a hung one. */
export type NoAnswer = Exclude<Reply<never>, { readonly kind: "answered" }>;

/**
 * Takes the socket at `path` and answers each request with `answer`; `held` when a live process holds it. Rejects when
 * `context` aborts, and when the take's guard stays held for `GUARD_MS`.
 */
export async function takeSocket(path: string, context: Context, answer?: Answer): Promise<Taken> {
	// Connections stay open until answered: a holder that answers nothing keeps them until its release.
	const open = new Set<Socket>();
	const server = createServer((socket) => {
		open.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => open.delete(socket));
		if (answer !== undefined) answerOn(socket, answer);
	});
	const own = await placed(server, open, path, context);
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

/** How long a take waits for its guard, which is held only for a look and a rename. */
export const GUARD_MS = 10_000;

/** How long a holder gets to answer by default. */
export const ASK_MS = 5000;

/** Asks the server on `dataDir`; an answer of a shape p3 does not know rejects. */
export function askServer(dataDir: string, request: ServerRequest, ms: number): Promise<Reply<ServerAnswer>> {
	return known(serverSocket(dataDir), request, ms, isServerAnswer);
}

/** Asks the supervisor on `dataDir`; an answer of a shape p3 does not know rejects. */
export function askSupervisor(
	dataDir: string,
	request: SupervisorRequest,
	ms: number,
): Promise<Reply<SupervisorAnswer>> {
	return known(supervisorSocket(dataDir), request, ms, isSupervisorAnswer);
}

/** The server's socket in `dataDir`. */
export function serverSocket(dataDir: string): string {
	return join(dataDir, "server.sock");
}

/** The supervisor's socket in `dataDir`. */
export function supervisorSocket(dataDir: string): string {
	return join(dataDir, "supervisor.sock");
}

/** The longest socket path this system binds, in bytes: 108 on Linux and Android (measured), 103 elsewhere. */
export const MAX_SOCKET_PATH_BYTES = process.platform === "linux" || process.platform === "android" ? 108 : 103;

/** Throws unless the sockets of the data directory `dataDir` fit this system's socket paths. */
export function checkSocketPaths(dataDir: string): void {
	// The longest of a Pi's socket paths, a take's temporary names (13 bytes) included.
	const path = supervisorSocket(dataDir);
	const bytes = Buffer.byteLength(path);
	if (bytes <= MAX_SOCKET_PATH_BYTES) return;
	throw new Error(
		`p3: the socket path ${path} is ${bytes} bytes, longer than the ${MAX_SOCKET_PATH_BYTES} this system allows; use a data directory with a shorter path`,
	);
}

/**
 * Sends `request` to the holder at `path` and reads its answer, within `ms` from now (at least 1 ms): `none` when nobody
 * holds it (also a holder that went away before it answered), `silent` when it did not answer in time.
 */
export function exchange(path: string, request: unknown, ms = ASK_MS): Promise<Reply<unknown>> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		// One deadline for the whole answer: a socket's own timeout restarts with every chunk.
		const timer = setTimeout(
			() => {
				resolve({ kind: "silent" });
				socket.destroy();
			},
			Math.max(1, ms),
		);
		// Decoded across chunks: a character split between two reads stays whole.
		socket.setEncoding("utf8");
		let text = "";
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: string) => {
			text += chunk;
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
		// After an answer or the deadline this settles nothing; before them, the holder went away.
		socket.once("close", () => {
			clearTimeout(timer);
			resolve({ kind: "none" });
		});
	});
}

/** A connect's errors that mean nobody holds the socket: no file, a file nobody listens on, or no socket there. */
const NOBODY = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

/** A connection's errors that mean its holder went away before it answered. */
const GONE = new Set(["ECONNRESET", "EPIPE"]);

/** `exchange`, its answer checked: a trust boundary, the answer of a process of the owner's whose pids are signalled. */
async function known<A>(
	path: string,
	request: unknown,
	ms: number,
	is: (answer: unknown) => answer is A,
): Promise<Reply<A>> {
	const reply = await exchange(path, request, ms);
	if (reply.kind !== "answered") return reply;
	if (is(reply.answer)) return { kind: "answered", answer: reply.answer };
	throw new Error(`p3: ${path} answered ${JSON.stringify(reply.answer).slice(0, 200)}`);
}

/**
 * `server` listening on a temporary name beside `path`, renamed into place under the guard unless a live process
 * holds `path`: the identity of the file it placed, or `undefined` (held). `server` is closed again on every other way
 * out (held, a failure, the guard's deadline), ending `open`.
 */
async function placed(
	server: Server,
	open: ReadonlySet<Socket>,
	path: string,
	context: Context,
): Promise<{ readonly ino: number; readonly dev: number } | undefined> {
	const temporary = join(dirname(path), `.${randomBytes(9).toString("base64url")}`);
	await listen(server, temporary);
	try {
		// A crash while it is held leaves the guard free (the kernel owns it on Linux and Android) and at most the
		// temporary file, which nobody takes (left there: see the header).
		const guard = await guardOf(path, context);
		try {
			if (await heldAt(path)) {
				await closed(server, open);
				return undefined;
			}
			const own = await lstat(temporary);
			// Replaces a killed holder's file at once: no moment without a socket at the path, nobody else's removed.
			await rename(temporary, path);
			return own;
		} finally {
			await guard.release();
		}
	} catch (error) {
		await closed(server, open);
		throw error;
	}
}

/** The take guard of `path`, within `GUARD_MS`; `context`'s abort rejects. */
async function guardOf(path: string, context: Context) {
	const deadline = AbortSignal.timeout(GUARD_MS);
	try {
		return await processLock(`p3-socket:${path}`, withAbortSignal(deadline, context));
	} catch (error) {
		if (!deadline.aborted || context.abortSignal?.aborted === true) throw error;
		throw new Error(
			`p3: the take guard of ${path} stayed held for ${GUARD_MS / 1000} s: another process holds it (on Linux and Android any local user can)`,
		);
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
		// On macOS and the BSDs a holder whose accept queue is full refuses too (ERNDL-1059); Linux says `EAGAIN`.
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

/** Reads one JSON line from `socket`, writes `answer`'s answer as one line, and ends it. */
function answerOn(socket: Socket, answer: Answer): void {
	socket.setEncoding("utf8");
	let text = "";
	socket.on("data", (chunk: string) => {
		text += chunk;
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

/** Makes `server` listen on `address`. */
function listen(server: Server, address: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(address, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

/** Whether `value` is one of the server's answers, its pids and port numbers ones that can be. */
function isServerAnswer(value: unknown): value is ServerAnswer {
	const answer = value as Record<string, unknown> | null;
	if (typeof answer !== "object" || answer === null) return false;
	switch (answer.kind) {
		case "starting":
			return isPid(answer.pid) && isPids(answer.workers);
		case "running":
			return (
				isPid(answer.pid) &&
				isPids(answer.workers) &&
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

/** Whether `value` is a list of pids. */
function isPids(value: unknown): value is readonly number[] {
	return Array.isArray(value) && value.every(isPid);
}

/** Whether `value` can be another process's pid: an integer above 1 (never 0, -1 or init, which `kill` reads apart). */
function isPid(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 1;
}
