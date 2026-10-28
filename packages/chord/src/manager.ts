// Host manager (Node only): runs a child host process and keeps at most one instance of it alive.
import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChordError } from "./errors.ts";
import { type IpcChannel, type IpcLink, ipcLink } from "./link.ts";

/** Control messages share the IPC channel with chord frames: `{ chord2control: message }`. */
export type ControlMessage =
	| { readonly type: "init"; readonly value: unknown }
	| { readonly type: "ready" }
	| { readonly type: "fatal"; readonly message: string; readonly reason?: string }
	| { readonly type: "shutdown" }
	| {
			readonly type: "status";
			readonly activeCalls?: number;
			readonly viewers?: number;
			readonly durableTasks?: number;
	  };

export interface Liveness {
	/** Started but not ready yet. */
	readonly booting: boolean;
	readonly activeCalls: number;
	/** Viewers the child reports (it counts heartbeating subscribers). */
	readonly viewers: number;
	readonly durableTasks: number;
	/** Milliseconds since the child last reported work (calls, viewers or tasks), or since it became ready. */
	readonly idleFor: number;
}

export interface Exit {
	readonly code: number | null;
	readonly signal: string | null;
}

/** A running child: its link (for `host.accept`) and its exit. */
export interface Instance {
	readonly pid: number;
	readonly link: IpcLink;
	readonly exited: Promise<Exit>;
	send(message: ControlMessage): void;
	/** Kills the child and everything it spawned. */
	killTree(): void;
	onControl(listener: (message: ControlMessage) => void): void;
}

export interface Driver {
	spawn(): Instance;
}

export interface ForkDriverOptions {
	/** The child's entry module. */
	readonly entry: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** Node flags for the child, e.g. `["--import", sourceResolver]` (default: none). */
	readonly execArgv?: readonly string[];
	/** Sent to the child as its first control message (`childControl().init`). */
	readonly init?: unknown;
	/**
	 * A lock name: one live process per name, across managers and processes. The child acquires it as a kernel lock
	 * (`childControl().lock()`, before opening its storage); a second child fails to start with `unavailable/locked`.
	 */
	readonly lock?: string;
	/** Optional stdout/stderr tap. Streams are still mirrored to the parent's standard output. */
	readonly onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
	/** Optional application metadata tap; control messages and chord frames keep their normal handling. */
	readonly onMessage?: (message: unknown) => void;
}

/**
 * A process lock owned by the kernel for the holder's lifetime: an abstract socket (Linux, Android) or a named pipe
 * (Windows) vanishes with its process, so there is no stale state to take over and no race between two would-be
 * owners. Other platforms need a socket file, removed on exit; a leftover one nobody accepts on is taken over.
 * The child acquires it (before opening storage), so the lock follows the process that owns the data.
 */
export async function processLock(name: string): Promise<() => Promise<void>> {
	const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
	const file = process.platform !== "win32" && process.platform !== "linux" && process.platform !== "android";
	const address =
		process.platform === "win32"
			? `\\\\.\\pipe\\chord2-${key}`
			: file
				? await lockSocketPath(`chord2-${key}.sock`)
				: `\0chord2-${key}`;
	const server = createServer((socket) => socket.end());
	for (;;) {
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(address, () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			if (!file || (await accepting(address))) {
				throw new ChordError("unavailable", `lock ${name} is held by another process`, { reason: "locked" });
			}
			await rm(address, { force: true });
		}
	}
	const removeFile = (): void => {
		try {
			unlinkSync(address);
		} catch {
			// Already gone.
		}
	};
	if (file) process.once("exit", removeFile);
	return () =>
		new Promise<void>((resolve, reject) => {
			if (file) process.removeListener("exit", removeFile);
			server.close((error) => (error ? reject(error) : resolve()));
		});
}

/** sun_path references 104 bytes on macOS and the BSDs, including the terminating NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * The lock socket's path: in the temporary directory, or, when that path does not fit in sun_path (a deep TMPDIR,
 * such as a test runner's below macOS's per-user one), in a private per-user directory under /tmp. Other users must
 * not be able to create or remove sockets there, so the directory has to be ours and closed to everyone else.
 */
async function lockSocketPath(file: string): Promise<string> {
	const preferred = join(tmpdir(), file);
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
	const uid = process.getuid?.() ?? 0;
	const directory = `/tmp/chord2-${uid}`;
	await mkdir(directory, { mode: 0o700, recursive: true });
	const stats = await lstat(directory);
	if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
		throw new ChordError("unavailable", `lock directory ${directory} must be a directory only its owner can access`);
	}
	return join(directory, file);
}

function accepting(address: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(address);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) =>
			resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"),
		);
	});
}

const LOCK_ENV = "CHORD2_LOCK";

/** A control message to a peer process that is gone: dropped (its exit or `disconnect` is reported separately). */
const ignoreSendError = (): void => {};

export function forkDriver(options: ForkDriverOptions): Driver {
	return {
		spawn() {
			// A lock this process inherited (e.g. as a child host itself) is not the child's: it gets only its own.
			const env: NodeJS.ProcessEnv = { ...process.env };
			delete env[LOCK_ENV];
			Object.assign(env, options.env);
			if (options.lock !== undefined) env[LOCK_ENV] = options.lock;
			// Detached: the child leads a process group, so the whole tree can be killed.
			const child: ChildProcess = fork(options.entry, [...(options.args ?? [])], {
				env,
				execArgv: [...(options.execArgv ?? [])],
				detached: true,
				stdio: ["ignore", options.onOutput ? "pipe" : "inherit", options.onOutput ? "pipe" : "inherit", "ipc"],
			});
			if (options.onOutput) {
				for (const stream of ["stdout", "stderr"] as const) {
					child[stream]?.on("data", (chunk: Buffer) => {
						options.onOutput!(stream, chunk);
						process[stream].write(chunk);
					});
				}
			}
			const pid = child.pid ?? -1;
			const killGroup = (): void => {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// No group left.
				}
			};
			const exited = new Promise<Exit>((resolve) => {
				child.once("exit", (code, signal) => {
					// However the leader ended (graceful, crash, kill), nothing it spawned outlives it.
					killGroup();
					resolve({ code, signal });
				});
			});
			const listeners = new Set<(message: ControlMessage) => void>();
			child.on("message", (message) => {
				options.onMessage?.(message);
				const control = (message as { chord2control?: ControlMessage } | null)?.chord2control;
				if (control !== undefined) for (const listener of listeners) listener(control);
			});
			const send = (message: ControlMessage): void => {
				// A child that exited before the channel reported it fails the write (EPIPE): its exit is what counts.
				if (child.connected) child.send({ chord2control: message }, ignoreSendError);
			};
			if (options.init !== undefined) send({ type: "init", value: options.init });
			return {
				pid,
				link: ipcLink(child as unknown as IpcChannel),
				exited,
				send,
				killTree: () => {
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				},
				onControl: (listener) => listeners.add(listener),
			};
		},
	};
}

export interface HostManagerOptions {
	readonly driver: Driver;
	/** Evaluated every `checkInterval` while running; `false` stops the child. */
	readonly keepAlive?: (liveness: Liveness) => boolean;
	readonly checkInterval?: number;
	/** Milliseconds a child may take to shut down before its process tree is killed (default 5000). */
	readonly grace?: number;
	/** Milliseconds to wait for `ready` (default 30000). */
	readonly readyTimeout?: number;
	/** The child exited on its own (crash, fatal) or after a stop. */
	readonly onExit?: (exit: Exit) => void;
}

export interface HostManager {
	readonly status: "stopped" | "starting" | "running" | "stopping";
	readonly instance: Instance | undefined;
	readonly liveness: Liveness;
	/** Starts the child (or returns the running one) once it reported ready. Serialized with stop/replace. */
	start(): Promise<Instance>;
	/** Asks the child to shut down, then kills its process tree after the grace period. */
	stop(): Promise<void>;
	/** Stop, wait for the exit, start. */
	replace(): Promise<Instance>;
}

export function createHostManager(options: HostManagerOptions): HostManager {
	let status: HostManager["status"] = "stopped";
	let instance: Instance | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	let report = { activeCalls: 0, viewers: 0, durableTasks: 0 };
	/** When the child last became idle; undefined while it reports work. */
	let idleSince: number | undefined;
	let booting = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const serialized = <T>(step: () => Promise<T>): Promise<T> => {
		const next = queue.then(step, step);
		queue = next.catch(() => {});
		return next;
	};

	const liveness = (): Liveness => ({
		booting,
		...report,
		idleFor: idleSince === undefined ? 0 : Date.now() - idleSince,
	});

	const doStop = async (): Promise<void> => {
		const current = instance;
		if (current === undefined) {
			status = "stopped";
			booting = false;
			return;
		}
		status = "stopping";
		if (timer !== undefined) clearInterval(timer);
		current.send({ type: "shutdown" });
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const graceful = await Promise.race([
			current.exited.then(() => true),
			new Promise<boolean>((resolve) => {
				graceTimer = setTimeout(() => resolve(false), options.grace ?? 5000);
			}),
		]);
		clearTimeout(graceTimer);
		if (!graceful) current.killTree();
		await current.exited;
		if (instance === current) instance = undefined;
		status = "stopped";
	};

	const doStart = async (): Promise<Instance> => {
		if (instance !== undefined && status === "running") return instance;
		status = "starting";
		booting = true;
		report = { activeCalls: 0, viewers: 0, durableTasks: 0 };
		let current: Instance;
		try {
			current = options.driver.spawn();
		} catch (error) {
			status = "stopped";
			booting = false;
			throw error;
		}
		instance = current;
		current.exited.then((exit) => {
			if (instance === current) {
				instance = undefined;
				status = "stopped";
				if (timer !== undefined) clearInterval(timer);
			}
			options.onExit?.(exit);
		});
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new ChordError("unavailable", "child not ready in time")),
				options.readyTimeout ?? 30_000,
			);
			const settle = (fn: () => void): void => {
				clearTimeout(timeout);
				fn();
			};
			current.exited.then((exit) =>
				settle(() =>
					reject(new ChordError("unavailable", `child exited before ready (${exit.code ?? exit.signal})`)),
				),
			);
			current.onControl((message) => {
				if (message.type === "ready") settle(resolve);
				else if (message.type === "fatal")
					settle(() =>
						reject(new ChordError("unavailable", `child failed: ${message.message}`, { reason: message.reason })),
					);
				else if (message.type === "status") {
					report = {
						activeCalls: message.activeCalls ?? 0,
						viewers: message.viewers ?? 0,
						durableTasks: message.durableTasks ?? 0,
					};
					// The idle clock starts at the busy → idle transition, not at the last busy report.
					if (report.activeCalls + report.viewers + report.durableTasks > 0) idleSince = undefined;
					else idleSince ??= Date.now();
				}
			});
		}).catch(async (error: unknown) => {
			current.killTree();
			await current.exited;
			throw error;
		});
		booting = false;
		if (report.activeCalls + report.viewers + report.durableTasks === 0) idleSince ??= Date.now();
		status = "running";
		if (options.keepAlive !== undefined) {
			const keepAlive = options.keepAlive;
			timer = setInterval(() => {
				if (status === "running" && !keepAlive(liveness())) void serialized(doStop);
			}, options.checkInterval ?? 1000);
			timer.unref?.();
		}
		return current;
	};

	return {
		get status() {
			return status;
		},
		get instance() {
			return instance;
		},
		get liveness() {
			return liveness();
		},
		start: () => serialized(doStart),
		stop: () => serialized(doStop),
		replace: () =>
			serialized(async () => {
				await doStop();
				return doStart();
			}),
	};
}

/** The child side of the control channel (call in the child's entry). */
export function childControl(channel: NodeJS.Process = process): {
	readonly init: Promise<unknown>;
	/**
	 * Acquires the manager's lock (if one was configured) as a kernel lock held for this process's lifetime. Call it
	 * before opening storage. Fails with `unavailable/locked`, also reported to the manager as a fatal start error.
	 */
	lock(): Promise<void>;
	ready(): void;
	fatal(error: unknown): void;
	report(status: { activeCalls?: number; viewers?: number; durableTasks?: number }): void;
	onShutdown(handler: () => void | Promise<void>): void;
} {
	const send = (message: ControlMessage): void => {
		// A parent that is gone fails the write (EPIPE); the `disconnect` that follows is how a child notices.
		if (channel.connected) channel.send?.({ chord2control: message }, undefined, undefined, ignoreSendError);
	};
	let resolveInit: (value: unknown) => void = () => {};
	const init = new Promise<unknown>((resolve) => {
		resolveInit = resolve;
	});
	const shutdown = new Set<() => void | Promise<void>>();
	channel.on("message", (message: unknown) => {
		const control = (message as { chord2control?: ControlMessage } | null)?.chord2control;
		if (control?.type === "init") resolveInit(control.value);
		if (control?.type === "shutdown") for (const handler of shutdown) void handler();
	});
	const fatal = (error: unknown): void =>
		send({
			type: "fatal",
			message: error instanceof Error ? error.message : String(error),
			...(error instanceof ChordError && error.reason !== undefined ? { reason: error.reason } : {}),
		});
	return {
		init,
		lock: async () => {
			const name = process.env[LOCK_ENV];
			if (name === undefined) return;
			try {
				await processLock(name);
			} catch (error) {
				fatal(error);
				throw error;
			}
		},
		ready: () => send({ type: "ready" }),
		fatal,
		report: (status) => send({ type: "status", ...status }),
		onShutdown: (handler) => shutdown.add(handler),
	};
}
