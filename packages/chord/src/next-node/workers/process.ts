// A worker process as the server sees it (slice 10 §3, Chord v1's `forkDriver`): forked with V8 serialization as a
// detached process group (the whole tree can be killed), stdout and stderr piped (the stderr tail kept, both mirrored to
// the server's own when the app takes no output), its IPC link made at the fork so the child's `hello` and early holds
// are queued, never lost; control messages, the link's close and the exit are told as they happen.

import { type ChildProcess, fork } from "node:child_process";
import type { Link } from "../../next/link/index.ts";
import { ipcLink } from "../../next/link/index.ts";
import { controlOf, envelope, type FromWorker, type ToWorker } from "./control.ts";

/** How a worker process is started: the bootstrap options of the workers component. */
export type ForkOptions = {
	readonly entry: string;
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** Its output; without it, mirrored to this process's own. */
	readonly onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
};

/** How a worker process ended. */
export type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** What a worker process tells as it happens. */
export type ProcessEvents = {
	readonly control: (message: FromWorker) => void;
	/** Its link was closed by this side (the heartbeat, a protocol error) while the child may live. */
	readonly linkLost: () => void;
	/** Its link was closed by the child's side (it exits, or it closed its IPC channel and may live on). */
	readonly linkClosed: () => void;
	readonly exited: (exit: Exit) => void;
};

/** How much of a worker's stderr is kept for its failure: 4 KiB. */
const STDERR_TAIL = 4096;

/** A control message to a child that is gone: dropped (its exit or link close tells). */
const ignoreSendError = (): void => {};

/** One forked worker process. */
export class WorkerProcess {
	readonly pid: number;
	readonly startedAt = Date.now();
	/** The link to the child's host, made at the fork. */
	readonly link: Link;
	/** Resolves with its exit; every process it spawned is killed then. */
	readonly exited: Promise<Exit>;
	readonly #child: ChildProcess;
	#stderr = "";

	constructor(options: ForkOptions, events: ProcessEvents) {
		const child = fork(options.entry, [], {
			env: { ...process.env, ...options.env },
			execArgv: [...(options.execArgv ?? [])],
			detached: true,
			serialization: "advanced",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		this.#child = child;
		this.pid = child.pid ?? -1;
		for (const stream of ["stdout", "stderr"] as const) {
			child[stream]?.on("data", (chunk: Buffer) => {
				if (stream === "stderr") this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
				if (options.onOutput !== undefined) options.onOutput(stream, chunk);
				else process[stream].write(chunk);
			});
		}
		this.link = new TellingLink(ipcLink(child), events);
		child.on("message", (message: unknown) => {
			const control = controlOf<FromWorker>(message);
			if (control !== undefined) events.control(control);
		});
		this.exited = new Promise<Exit>((resolve) => {
			const ended = (exit: Exit): void => {
				// However the leader ended, nothing it spawned outlives it.
				this.#killGroup();
				resolve(exit);
				events.exited(exit);
			};
			child.once("exit", (code, signal) => ended({ code, signal }));
			// A fork that failed (no `exit` follows).
			child.once("error", () => {
				if (child.pid === undefined) ended({ code: null, signal: null });
			});
		});
	}

	/** The last bytes it wrote to stderr, if any. */
	get stderrTail(): string | undefined {
		return this.#stderr === "" ? undefined : this.#stderr;
	}

	/** Sends a control message; dropped when the child is gone (its exit tells). */
	send(message: ToWorker): void {
		if (this.#child.connected) this.#child.send(envelope(message), ignoreSendError);
	}

	/** Kills the child and every process it spawned. */
	kill(): void {
		if (!this.#killGroup()) this.#child.kill("SIGKILL");
	}

	/** Kills the process group; `false` when there is none. */
	#killGroup(): boolean {
		try {
			process.kill(-this.pid, "SIGKILL");
			return true;
		} catch {
			return false;
		}
	}
}

/** A link that also tells who closed it (`linkLost`: this side, `linkClosed`: the child's), whoever listens to it. */
class TellingLink implements Link {
	readonly #inner: Link;
	readonly #events: Pick<ProcessEvents, "linkLost" | "linkClosed">;
	#listener: (() => void) | undefined;
	#closed = false;

	constructor(inner: Link, events: Pick<ProcessEvents, "linkLost" | "linkClosed">) {
		this.#inner = inner;
		this.#events = events;
		inner.onClose(() => {
			const here = this.#closed;
			this.#closed = true;
			this.#listener?.();
			if (!here) events.linkClosed();
		});
	}

	send(message: Uint8Array): void {
		this.#inner.send(message);
	}

	onMessage(listener: (message: Uint8Array) => void): void {
		this.#inner.onMessage(listener);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#events.linkLost();
		this.#inner.close();
	}

	onClose(listener: () => void): void {
		if (this.#closed) listener();
		else this.#listener = listener;
	}
}
