import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Frame types (docs/protocol.md). */
const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;

const MAX_FRAME = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
/** The daemon pings every five seconds; this much silence means the connection is gone. */
const SILENCE_LIMIT_MS = 30_000;
/** How long starting the daemon and its `hello` may take. */
const START_TIMEOUT_MS = 60_000;

export type Json = Record<string, unknown>;

/** A failure reported by the daemon, with its Node-style code. */
export class RemoteError extends Error {
	readonly code: string;
	readonly path?: string;
	readonly fields: Json;

	constructor(fields: Json) {
		super(typeof fields.message === "string" ? fields.message : "Remote operation failed");
		this.name = "RemoteError";
		this.code = typeof fields.code === "string" ? fields.code : "unknown";
		if (typeof fields.path === "string") this.path = fields.path;
		this.fields = fields;
	}
}

/** What `hello` reports about the remote machine. */
export interface RemoteInfo {
	protocol: number;
	version: string;
	os: string;
	arch: string;
	home: string;
	tmpdir: string;
	/** Path separator: `/`, or `\\` on Windows. */
	separator: string;
	/** The daemon's working directory, where Node's `path.resolve` would fall back to `process.cwd()`. */
	cwd: string;
	/** Windows: per-drive working directories (`C:` → `C:\\work`) of the `=C:` variables. */
	driveCwds: Record<string, string>;
	pid: number;
}

export interface ConnectionOptions {
	/**
	 * Command that starts the daemon, before its `serve --token <hex>` arguments, e.g. `["ssh", "-T", "--", "host",
	 * "~/.pi/mobile/tools/pi-env"]`. A function computes it at each start (detecting and deploying first, for example);
	 * its failure fails that start, and the next request tries again.
	 */
	command: readonly string[] | (() => Promise<readonly string[]>);
	/** Receives the daemon's and the transport's diagnostic output. */
	onLog?: (text: string) => void;
}

export interface Reply {
	json: Json;
	payload: Uint8Array;
	/** The daemon session that answered; handles from it are only valid while it lives. */
	session: number;
}

type Pending = {
	resolve: (value: Reply) => void;
	reject: (error: Error) => void;
	onEvent?: (json: Json, payload: Uint8Array) => void;
};

export interface RequestOptions {
	payload?: Uint8Array;
	/** Aborting sends `cancel`; the request still settles with the daemon's result or error. */
	signal?: AbortSignal;
	/** Progress events of the request, such as `exec` output. */
	onEvent?: (json: Json, payload: Uint8Array) => void;
	/** The request's id and session, for `kill`. */
	onStart?: (id: number, session: number) => void;
	/**
	 * Only run in this daemon session, for requests on handles it opened. After the connection was lost and started
	 * again, such requests fail instead of reaching a daemon that never opened the handle.
	 */
	session?: number;
}

/** Lone surrogates become U+FFFD, as Node encodes strings for system calls. */
function wellFormed(_key: string, value: unknown): unknown {
	return typeof value === "string" ? value.toWellFormed() : value;
}

function frame(type: number, id: number, json: Json, payload: Uint8Array = new Uint8Array(0)): Buffer {
	const body = Buffer.from(JSON.stringify(json, wellFormed), "utf8");
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length + payload.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body, payload]);
}

/** The connection failed or ended; a request may succeed once it is started again. */
function lost(message: string): RemoteError {
	return new RemoteError({ code: "unknown", message, lost: true });
}

/** Whether an error means the connection was lost, not that the daemon refused the request. */
export function isConnectionLost(error: unknown): boolean {
	return error instanceof RemoteError && error.fields.lost === true;
}

function closed(): RemoteError {
	return new RemoteError({ code: "unknown", message: "Connection closed" });
}

/** One running daemon. */
class Session {
	readonly id: number;
	readonly child: ChildProcessWithoutNullStreams;
	readonly token: string;
	readonly pending = new Map<number, Pending>();
	/** Received bytes not yet parsed, without concatenating on every chunk. */
	chunks: Buffer[] = [];
	buffered = 0;
	synced = false;
	lastSeen = Date.now();
	timer: ReturnType<typeof setInterval> | undefined;
	live = true;

	constructor(id: number, child: ChildProcessWithoutNullStreams, token: string) {
		this.id = id;
		this.child = child;
		this.token = token;
	}

	/** The first `length` buffered bytes as one buffer, without consuming them. */
	peek(length: number): Buffer {
		if (this.chunks[0]!.length < length) {
			this.chunks = [Buffer.concat(this.chunks)];
		}
		return this.chunks[0]!.subarray(0, length);
	}

	consume(length: number): void {
		this.buffered -= length;
		while (length > 0) {
			const first = this.chunks[0]!;
			if (first.length <= length) {
				this.chunks.shift();
				length -= first.length;
			} else {
				this.chunks[0] = first.subarray(length);
				length = 0;
			}
		}
	}
}

/**
 * One connection to a pi-env daemon: started lazily on the first request and started again after it is lost. Requests
 * in flight when it is lost fail with code `unknown`; for mutations their outcome is then unknown.
 */
export class Connection {
	readonly #options: ConnectionOptions;
	#session: Session | undefined;
	#ready: Promise<{ info: RemoteInfo; session: Session }> | undefined;
	#sessions = 0;
	#nextId = 1;
	#closed = false;

	constructor(options: ConnectionOptions) {
		this.#options = options;
	}

	/** Connect if needed and return what the daemon reported about its machine. */
	async info(): Promise<RemoteInfo> {
		return (await this.#connect()).info;
	}

	/** Connect if needed and return the live session's id. */
	async session(): Promise<number> {
		return (await this.#connect()).session.id;
	}

	async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
		if (options.session !== undefined) {
			const current = this.#session;
			if (current === undefined || current.id !== options.session || !current.live) {
				throw lost("pi-env connection lost");
			}
			return this.#send(current, op, json, options);
		}
		const { session } = await this.#connect();
		return this.#send(session, op, json, options);
	}

	/** Stop the daemon; it kills everything it started. */
	close(): void {
		this.#closed = true;
		if (this.#session) this.#teardown(this.#session, closed());
	}

	/** Kill one `exec` without aborting it. */
	kill(id: number, session: number): void {
		const current = this.#session;
		if (current?.id === session && current.live) this.#write(current, frame(CANCEL, id, { mode: "kill" }));
	}

	#connect(): Promise<{ info: RemoteInfo; session: Session }> {
		if (this.#closed) return Promise.reject(closed());
		if (this.#ready === undefined) {
			const ready = this.#start();
			this.#ready = ready;
			// A failed start is not remembered: the next request tries again.
			ready.catch(() => {
				if (this.#ready === ready) this.#ready = undefined;
			});
		}
		return this.#ready;
	}

	#send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
		if (!session.live) return Promise.reject(lost("pi-env connection lost"));
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => this.#write(session, frame(CANCEL, id, {}));
			const done = () => options.signal?.removeEventListener("abort", onAbort);
			session.pending.set(id, {
				resolve: (value) => {
					done();
					resolve(value);
				},
				reject: (error) => {
					done();
					reject(error);
				},
				...(options.onEvent ? { onEvent: options.onEvent } : {}),
			});
			options.signal?.addEventListener("abort", onAbort, { once: true });
			options.onStart?.(id, session.id);
			this.#write(session, frame(REQUEST, id, { ...json, op }, options.payload));
			if (options.signal?.aborted) onAbort();
		});
	}

	#write(session: Session, data: Buffer): void {
		if (session.live) session.child.stdin.write(data);
	}

	async #start(): Promise<{ info: RemoteInfo; session: Session }> {
		let command: readonly string[];
		try {
			const option = this.#options.command;
			command = typeof option === "function" ? await option() : option;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new RemoteError({ code: "spawn_error", message, lost: true });
		}
		if (this.#closed) throw closed();
		const [program, ...args] = command;
		if (program === undefined) throw new RemoteError({ code: "spawn_error", message: "No daemon command" });
		const token = randomBytes(16).toString("hex");
		const child = spawn(program, [...args, "serve", "--token", token], { stdio: ["pipe", "pipe", "pipe"] });
		const session = new Session(++this.#sessions, child, token);
		this.#session = session;
		let startTimer: ReturnType<typeof setTimeout> | undefined;
		const failed = new Promise<never>((_resolve, reject) => {
			startTimer = setTimeout(
				() => reject(lost(`pi-env did not answer within ${START_TIMEOUT_MS / 1000} s`)),
				START_TIMEOUT_MS,
			);
			child.once("error", (error) =>
				reject(new RemoteError({ code: "spawn_error", message: error.message, lost: true })),
			);
			child.once("exit", (code) => reject(lost(`pi-env exited with code ${code} before it was ready`)));
		});
		failed.catch(() => {});
		child.stdout.on("data", (chunk: Buffer) => this.#onData(session, chunk));
		child.stderr.on("data", (chunk: Buffer) => this.#options.onLog?.(chunk.toString("utf8")));
		child.on("error", () => this.#teardown(session, lost("pi-env connection lost")));
		child.on("exit", () => this.#teardown(session, lost("pi-env connection lost")));
		child.stdin.on("error", () => {});
		session.timer = setInterval(() => {
			this.#write(session, frame(PING, 0, {}));
			if (Date.now() - session.lastSeen > SILENCE_LIMIT_MS) {
				this.#teardown(session, lost("pi-env connection timed out"));
			}
		}, PING_INTERVAL_MS);
		session.timer.unref();
		try {
			const { json } = await Promise.race([this.#send(session, "hello", { protocol: 1 }, {}), failed]);
			if (json.protocol !== 1) throw lost(`Unsupported protocol ${json.protocol}`);
			return { info: json as unknown as RemoteInfo, session };
		} catch (error) {
			this.#teardown(session, error instanceof Error ? error : lost(String(error)));
			throw error;
		} finally {
			clearTimeout(startTimer);
		}
	}

	#teardown(session: Session, error: Error): void {
		if (!session.live) return;
		session.live = false;
		clearInterval(session.timer);
		if (this.#session === session) {
			this.#session = undefined;
			this.#ready = undefined;
		}
		session.child.stdin.end();
		session.child.kill();
		const pending = [...session.pending.values()];
		session.pending.clear();
		for (const request of pending) request.reject(error);
	}

	#onData(session: Session, chunk: Buffer): void {
		if (!session.live) return;
		session.lastSeen = Date.now();
		session.chunks.push(chunk);
		session.buffered += chunk.length;
		if (!session.synced) {
			// Shell startup files may print before the daemon runs; skip everything before its sync line.
			const marker = Buffer.from(`PI-ENV ${session.token}\n`, "utf8");
			const all = session.peek(session.buffered);
			const index = all.indexOf(marker);
			if (index === -1) {
				if (session.buffered > 1024 * 1024) {
					session.consume(session.buffered - marker.length);
				}
				return;
			}
			const noise = all.subarray(0, index).toString("utf8").trim();
			if (noise !== "") this.#options.onLog?.(noise);
			session.consume(index + marker.length);
			session.synced = true;
		}
		while (session.live && session.buffered >= 4) {
			const length = session.peek(4).readUInt32BE(0);
			if (length < 9 || length > MAX_FRAME) {
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				return;
			}
			if (session.buffered < 4 + length) return;
			const body = session.peek(4 + length).subarray(4);
			const type = body.readUInt8(0);
			const id = body.readUInt32BE(1);
			const jsonLength = body.readUInt32BE(5);
			let json: Json;
			try {
				if (9 + jsonLength > length) throw new Error("JSON length out of range");
				const parsed: unknown = JSON.parse(body.subarray(9, 9 + jsonLength).toString("utf8"));
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
					throw new Error("not an object");
				json = parsed as Json;
			} catch {
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				return;
			}
			// A plain Uint8Array copy, like `NodeExecutionEnv`'s reader results, not a view of the receive buffer.
			const payload = new Uint8Array(body.subarray(9 + jsonLength));
			session.consume(4 + length);
			this.#dispatch(session, type, id, json, payload);
		}
	}

	#dispatch(session: Session, type: number, id: number, json: Json, payload: Uint8Array): void {
		const pending = session.pending.get(id);
		if (type === EVENT) {
			pending?.onEvent?.(json, payload);
			return;
		}
		if (type !== RESULT && type !== ERROR) return;
		if (pending === undefined) return;
		session.pending.delete(id);
		if (type === RESULT) pending.resolve({ json, payload, session: session.id });
		else pending.reject(new RemoteError(json));
	}
}
