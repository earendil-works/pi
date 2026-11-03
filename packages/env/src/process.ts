import { type Connection, RemoteError } from "./connection.ts";

/** Input larger than this goes to the daemon in several writes; frames are at most 16 MiB. */
const WRITE_CHUNK = 1024 * 1024;

export interface ProcessOptions {
	/** Working directory of the program; it must exist. */
	cwd: string;
	/** Program and arguments, run directly without a shell. */
	argv: readonly string[];
	/** Added to the daemon's environment, or the whole environment with `inheritEnv: false`. */
	env?: Record<string, string>;
	inheritEnv?: boolean;
	/** The program's stdout, raw bytes in order. */
	onStdout: (bytes: Uint8Array) => void;
	/** The program's stderr, raw bytes in order. */
	onStderr?: (bytes: Uint8Array) => void;
}

/**
 * A program running with plain pipes in a pi-env daemon, for programs that speak a protocol on stdin and stdout. It
 * ends when the program exits, `close()` kills it, or the connection is lost (the daemon then kills it).
 */
export class RemoteProcess {
	readonly pid: number;
	/** The exit code; rejects with the daemon's error, with code `aborted` after `close()`. */
	readonly exited: Promise<number>;
	readonly #connection: Connection;
	readonly #id: number;
	readonly #session: number;
	readonly #abort: AbortController;

	constructor(
		connection: Connection,
		id: number,
		session: number,
		pid: number,
		exited: Promise<number>,
		abort: AbortController,
	) {
		this.#connection = connection;
		this.#id = id;
		this.#session = session;
		this.pid = pid;
		this.exited = exited;
		this.#abort = abort;
	}

	/** Write to the program's stdin, in order; once stdin is closed or the program has ended, input is dropped. */
	write(data: Uint8Array | string): void {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) {
			this.#request("processWrite", bytes.subarray(offset, offset + WRITE_CHUNK));
		}
	}

	/** Close the program's stdin after the input written before it. */
	closeStdin(): void {
		this.#request("processCloseStdin");
	}

	/** Kill the program and its process group. */
	close(): void {
		this.#abort.abort();
	}

	#request(op: string, payload?: Uint8Array): void {
		this.#connection
			.request(op, { target: this.#id }, { session: this.#session, ...(payload ? { payload } : {}) })
			// Stdin already closed, the program ended, or a lost connection: `exited` reports the end.
			.catch(() => {});
	}
}

/**
 * Start a program with plain pipes in the daemon behind `connection`. Fails with `not_supported` when the daemon was
 * released before the `process` operation.
 */
export async function openProcess(connection: Connection, options: ProcessOptions): Promise<RemoteProcess> {
	if (!(await connection.info()).features?.includes("process")) {
		throw new RemoteError({ code: "not_supported", message: "The pi-env daemon cannot run processes; update it" });
	}
	const abort = new AbortController();
	const started = Promise.withResolvers<RemoteProcess>();
	let request: { id: number; session: number } | undefined;
	const exited = connection
		.request(
			"process",
			{
				cwd: options.cwd,
				argv: options.argv,
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
			},
			{
				signal: abort.signal,
				onStart: (id, session) => {
					request = { id, session };
				},
				onEvent: (json, payload) => {
					if (json.kind === "output") {
						if (json.stream === "stderr") options.onStderr?.(payload);
						else options.onStdout(payload);
					} else if (json.kind === "started" && request) {
						started.resolve(
							new RemoteProcess(connection, request.id, request.session, Number(json.pid), exited, abort),
						);
					}
				},
			},
		)
		.then((reply) => Number(reply.json.exitCode));
	// Failing before it started rejects the open; afterwards, `exited` carries it.
	exited.catch(started.reject);
	return started.promise;
}
