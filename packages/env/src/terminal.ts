import type { Connection, Json } from "./connection.ts";

/** Input larger than this goes to the daemon in several writes; frames are at most 16 MiB. */
const WRITE_CHUNK = 1024 * 1024;

export interface TerminalOptions {
	/** Working directory of the program; it must exist. */
	cwd: string;
	/** Program and arguments. Default: the user's shell (`SHELL` in `env` or the daemon's environment) as a login shell. */
	argv?: readonly string[];
	/** Added to the daemon's environment, or the whole environment with `inheritEnv: false`. Set `TERM` here. */
	env?: Record<string, string>;
	inheritEnv?: boolean;
	cols: number;
	rows: number;
	/** The terminal's raw output, in order. */
	onData: (bytes: Uint8Array) => void;
}

/** The foreground job of a terminal: its process group id, and its leader's name if the system tells. */
export interface TerminalForeground {
	pid: number;
	name?: string;
}

/**
 * A program running in a pseudo-terminal of a pi-env daemon. It ends when the program exits, `close()` kills it, or
 * the connection is lost (the daemon then kills it).
 */
export class RemoteTerminal {
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

	/** Send input; once the terminal has ended, input is dropped. */
	write(data: Uint8Array | string): void {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) {
			this.#request("ptyWrite", {}, bytes.subarray(offset, offset + WRITE_CHUNK));
		}
	}

	/** Change the size; the program receives `SIGWINCH`. */
	resize(cols: number, rows: number): void {
		this.#request("ptyResize", { cols, rows });
	}

	/** Kill the program and everything in its session. */
	close(): void {
		this.#abort.abort();
	}

	/**
	 * The job in the terminal's foreground when it is not the program itself: what a shell runs, such as an editor.
	 * Undefined while the program is in front (a shell at its prompt). Rejects once the terminal has ended.
	 */
	async foreground(): Promise<TerminalForeground | undefined> {
		const reply = await this.#connection.request("ptyForeground", { target: this.#id }, { session: this.#session });
		const foreground = reply.json.foreground as { pid: number; name: string | null } | null;
		if (!foreground) return undefined;
		return { pid: foreground.pid, ...(foreground.name ? { name: foreground.name } : {}) };
	}

	#request(op: string, json: Json, payload?: Uint8Array): void {
		this.#connection
			.request(op, { ...json, target: this.#id }, { session: this.#session, ...(payload ? { payload } : {}) })
			// A terminal that ended or a lost connection: `exited` reports it.
			.catch(() => {});
	}
}

/** Start a program in a new pseudo-terminal of the daemon behind `connection`. */
export function openTerminal(connection: Connection, options: TerminalOptions): Promise<RemoteTerminal> {
	const abort = new AbortController();
	const started = Promise.withResolvers<RemoteTerminal>();
	let request: { id: number; session: number } | undefined;
	const exited = connection
		.request(
			"pty",
			{
				cwd: options.cwd,
				...(options.argv === undefined ? {} : { argv: options.argv }),
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
				cols: options.cols,
				rows: options.rows,
			},
			{
				signal: abort.signal,
				onStart: (id, session) => {
					request = { id, session };
				},
				onEvent: (json, payload) => {
					if (json.kind === "output") options.onData(payload);
					else if (json.kind === "started" && request) {
						started.resolve(
							new RemoteTerminal(connection, request.id, request.session, Number(json.pid), exited, abort),
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
