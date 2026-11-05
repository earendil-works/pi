// The session workers on Chord v2's workers component: one forked worker per session, started on the first hold,
// stopped when idle, its failure kept until a retry. On top: worker generations (in the worker principal and start
// data), logs and owner notices, restarts after a crash (as v1), and the lifecycle steps of relocation and cloning,
// serialized per session.
import { realpathSync } from "node:fs";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Plugins } from "@earendil-works/chord/plugins";
import { createWorkers, type WorkerState, type Workers, type WorkersError } from "@earendil-works/chord/workers";
import { type Host, Session } from "../runtime/chord.ts";
import { logWriter, processLogs } from "../runtime/logs.ts";
import { canView, type P2Principal } from "../runtime/principals.ts";
import type { HostEvent, RelocationSteps, SessionWorkerControl } from "../runtime/server.ts";
import type { WorkerInit } from "../runtime/worker.ts";

export type SessionWorkersOptions = {
	readonly host: Host;
	readonly plugins: Plugins;
	readonly app: string;
	readonly dataDir: string;
	readonly fake: boolean;
	readonly entry: string;
	readonly execArgv: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** A worker with no references, calls or Durable tasks stops after this long (default 5 minutes). */
	readonly idleMs?: number;
	/** How long a running worker may take to follow a relocation before it is restarted instead (default 60 s). */
	readonly moveTimeoutMs?: number;
	/** The start data's values (`WorkerInit.values`) for a session; a throw refuses the start. */
	readonly values: (session: string, context: Context) => Promise<WorkerInit["values"]>;
};

export const SESSION_PREFIX = "session:";

/** How many crash restarts of a session's worker p2 makes within `CRASH_WINDOW_MS`; the next crash waits for Retry. */
const CRASH_RESTARTS = 5;
const CRASH_WINDOW_MS = 60_000;

export class SessionWorkers implements SessionWorkerControl {
	/** Chord's workers component, made by `create` (its worker base bundled first). */
	#workers: Workers<typeof Session> | undefined;
	readonly #options: SessionWorkersOptions;
	readonly #generations = new Map<string, number>();
	readonly #operations = new Map<string, Promise<unknown>>();
	readonly #listeners = new Set<(event: HostEvent) => void>();
	readonly #writers = new Map<string, ReturnType<typeof logWriter>>();
	/** The redacted reason of each session's last failed start or crash (Chord's public error is a fixed message). */
	readonly #reasons = new Map<string, string>();
	/** A crash's "Worker exited (signal)" until its `worker_failed` arrives. */
	readonly #exits = new Map<string, string>();
	/** When p2 restarted each session's worker after a crash (`#crashed`), within the last `CRASH_WINDOW_MS`. */
	readonly #crashRestarts = new Map<string, number[]>();
	/** The last state of each session's worker, to emit changes only. */
	#states: Readonly<Record<string, WorkerState>> = {};
	#generation = 0;

	private constructor(options: SessionWorkersOptions) {
		this.#options = options;
		processLogs.redactor.addDirectory(options.dataDir);
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (/(?:key|token|secret|password|cookie|auth)/i.test(key)) processLogs.redactor.addSecret(value);
		}
	}

	/**
	 * The session workers: Chord's workers component created (it bundles the worker entry once, so every worker runs the
	 * code the server booted with; a broken entry rejects), then followed.
	 */
	static async create(options: SessionWorkersOptions, context: Context): Promise<SessionWorkers> {
		const made = new SessionWorkers(options);
		made.#workers = await made.#createWorkers(context);
		void made.#follow();
		return made;
	}

	/** Chord's workers component for the sessions. */
	get workers(): Workers<typeof Session> {
		// Set by `create` before the instance is handed out.
		return this.#workers!;
	}

	#createWorkers(context: Context): Promise<Workers<typeof Session>> {
		const options = this.#options;
		const dataDir = realpathSync(options.dataDir);
		return createWorkers(
			options.host,
			Session,
			{
				kind: "worker",
				entry: options.entry,
				execArgv: options.execArgv,
				...(options.env === undefined ? {} : { env: options.env }),
				// Owners reach every session, the server's own code too (`SERVER`); guests only the sessions their grant names.
				authorize: (principal: P2Principal, address) =>
					principal.kind === "server" || canView(principal, address.params.id),
				principal: (address): P2Principal => ({
					kind: "worker",
					session: address.params.id,
					generation: this.generation(address.params.id),
				}),
				start: async (address, context) => {
					const session = address.params.id;
					const generation = ++this.#generation;
					this.#generations.set(session, generation);
					processLogs.append(`${SESSION_PREFIX}${session}`, "event", `Starting worker generation ${generation}`);
					const values = await options.values(session, context);
					const init: WorkerInit = {
						app: options.app,
						dataDir: options.dataDir,
						fake: options.fake,
						generation,
						values,
					};
					return init as unknown as JsonValue;
				},
				lock: (address) => `p2:${dataDir}:worker:${address.params.id}`,
				idleMs: () => options.idleMs ?? 300_000,
				plugins: options.plugins,
				onOutput: (address, stream, chunk) => this.#writer(String(address.params.id), stream).write(chunk),
				onError: (error) => this.#failed(error),
			},
			context,
		);
	}

	/** Generation of the session's latest worker (0: never started). */
	generation(session: string): number {
		return this.#generations.get(session) ?? 0;
	}

	/** Sessions whose worker is running now. */
	running(): string[] {
		return Object.entries(this.workers.state.value).flatMap(([key, state]) =>
			state.status === "running" ? [key.slice("session|".length)] : [],
		);
	}

	subscribe(listener: (event: HostEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async relocate(session: string, steps: RelocationSteps): Promise<void> {
		const source = `${SESSION_PREFIX}${session}`;
		const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
		await this.#serially(session, async () => {
			const status = this.#status(session);
			if (status === "starting" || status === "stopping")
				throw new Error(
					"Background work is still running (for example a message waiting for a subagent's answer): wait for it or stop the subagent before changing directory",
				);
			// Not running: the next start reads the moved catalog; holders arriving meanwhile wait (suspended).
			if (status !== "running") return this.#suspended(session, steps.update);
			let refusal: string | undefined;
			try {
				refusal = await steps.prepare();
			} catch (error) {
				if (this.#status(session) !== "running") return this.#suspended(session, steps.update);
				// The fence may be up (the failure came after it): never leave a worker that refuses everything.
				processLogs.append(source, "event", `Preparing a move failed (${message(error)}); stopping the worker`);
				await this.#stopped(session);
				throw error;
			}
			if (refusal !== undefined) throw new Error(refusal);
			try {
				await steps.update();
			} catch (error) {
				if (this.#status(session) === "running") {
					try {
						await steps.cancel();
					} catch (failure) {
						processLogs.append(
							source,
							"event",
							`Lifting the move's fence failed (${message(failure)}); stopping the worker`,
						);
						await this.#stopped(session);
					}
				}
				throw error;
			}
			if (this.#status(session) !== "running") return;
			try {
				// Bounded like a start: a worker that does not follow in time, or exits meanwhile, is restarted below.
				await bounded(
					this.#whileRunning(session, steps.move()),
					this.#options.moveTimeoutMs ?? 60_000,
					"Moving the worker",
				);
			} catch (error) {
				processLogs.append(
					source,
					"event",
					`The worker could not follow the move (${message(error)}); restarting it`,
				);
				// The catalog is moved: the next start (now, if held) reads it; a failed start is the worker's error.
				await this.#suspended(session, async () => {});
			}
		});
	}

	async pause(
		session: string,
		prepare: () => Promise<string | undefined>,
		work: () => Promise<void>,
		doing: string,
	): Promise<void> {
		await this.#serially(session, async () => {
			const status = this.#status(session);
			if (status === "starting" || status === "stopping")
				throw new Error(
					`Background work is still running (for example a message waiting for a subagent's answer): wait for it or stop the subagent before ${doing}`,
				);
			if (status === "running") {
				let refusal: string | undefined;
				try {
					refusal = await prepare();
				} catch (error) {
					if (this.#status(session) === "running") {
						processLogs.append(
							`${SESSION_PREFIX}${session}`,
							"event",
							`Preparing to pause failed (${error instanceof Error ? error.message : String(error)}); stopping the worker`,
						);
						await this.#suspended(session, async () => {});
						throw error;
					}
				}
				if (refusal !== undefined) throw new Error(refusal);
			}
			await this.#suspended(session, work);
		});
	}

	async retry(session: string): Promise<void> {
		this.#crashRestarts.delete(session);
		await this.#serially(session, async () => {
			await this.#suspended(session, async () => {
				const source = `${SESSION_PREFIX}${session}`;
				for (const notice of processLogs.notices())
					if (notice.source === source) processLogs.dismissNotice(notice.id);
				processLogs.append(source, "event", "Worker retry requested");
			});
		});
	}

	/** Stops the session's worker and clears its failure: the next hold (one waiting now too) starts it again. */
	async stop(session: string): Promise<void> {
		await this.#serially(session, () =>
			this.#suspended(session, async () => {
				for (const notice of processLogs.notices())
					if (notice.source === `${SESSION_PREFIX}${session}`) processLogs.dismissNotice(notice.id);
			}),
		);
	}

	/**
	 * Stops an archived session's worker for good: its holders (a page's lingering conversation, say) wait suspended
	 * instead of starting a worker the archived session refuses, which failed with an owner notice. `retry` (restore)
	 * ends the suspension; so does the release of its last holder (a later hold is refused as archived).
	 */
	async suspend(session: string): Promise<void> {
		this.#crashRestarts.delete(session);
		await this.#serially(session, async () => {
			await this.workers.stop(Session({ id: session }), BACKGROUND_CONTEXT);
			for (const notice of processLogs.notices())
				if (notice.source === `${SESSION_PREFIX}${session}`) processLogs.dismissNotice(notice.id);
		});
	}

	/** Stops every worker; their exits are no news to subscribers (the server's objects close next). */
	close(context: Context): Promise<void> {
		this.#listeners.clear();
		return this.workers.close(context);
	}

	/**
	 * Runs `work` while the session's worker is stopped and its holders wait (suspended); then starts it if held and
	 * waits for that start's outcome (running or failed), as callers read the worker's state next.
	 */
	async #suspended(session: string, work: () => Promise<void>): Promise<void> {
		const address = Session({ id: session });
		await this.workers.stop(address, BACKGROUND_CONTEXT);
		try {
			await work();
		} finally {
			await this.workers.retry(address, BACKGROUND_CONTEXT);
			await this.#started(session);
		}
	}

	/** Stops the session's worker; its holders start a new one (not waited for: the caller reports the stop). */
	async #stopped(session: string): Promise<void> {
		const address = Session({ id: session });
		await this.workers.stop(address, BACKGROUND_CONTEXT);
		await this.workers.retry(address, BACKGROUND_CONTEXT);
	}

	/** `step`, rejected as soon as the session's worker is no longer running (it exited while the step waits on it). */
	async #whileRunning<T>(session: string, step: Promise<T>): Promise<T> {
		const watch = await this.workers.state.watch(BACKGROUND_CONTEXT);
		try {
			return await Promise.race([
				step,
				new Promise<never>((_resolve, reject) => {
					const check = () => {
						if (this.#status(session) !== "running") reject(new Error("The worker exited"));
					};
					check();
					watch.start(async () => check());
				}),
			]);
		} finally {
			await watch.stop();
		}
	}

	/** Resolves once a start of `session`'s worker the retry began (its holders') is running or failed. */
	async #started(session: string): Promise<void> {
		// The route resolves its held addresses asynchronously: the start shows within a few turns, or never (unheld).
		for (let turn = 0; turn < 5 && this.#status(session) === undefined; turn++)
			await new Promise((resolve) => setImmediate(resolve));
		if (this.#status(session) !== "starting") return;
		const watch = await this.workers.state.watch(BACKGROUND_CONTEXT);
		try {
			await new Promise<void>((resolve) => {
				const settled = () => this.#status(session) !== "starting";
				if (settled()) return resolve();
				watch.start(async () => {
					if (settled()) resolve();
				});
			});
		} finally {
			await watch.stop();
		}
	}

	#status(session: string): string | undefined {
		return this.workers.state.value[`session|${session}`]?.status;
	}

	/** Runs `step` after the session's earlier lifecycle steps. */
	#serially<T>(session: string, step: () => Promise<T>): Promise<T> {
		const run = (this.#operations.get(session) ?? Promise.resolve()).then(step);
		this.#operations.set(
			session,
			run.catch(() => {}),
		);
		return run;
	}

	#writer(session: string, stream: "stdout" | "stderr"): ReturnType<typeof logWriter> {
		const source = `${SESSION_PREFIX}${session}`;
		const key = `${session}:${stream}`;
		let writer = this.#writers.get(key);
		if (!writer) {
			writer =
				stream === "stdout"
					? logWriter(source, "stdout")
					: logWriter(source, "stderr", processLogs, (line) => {
							if (line.startsWith("p2 worker:") && !line.includes("aborted:")) processLogs.notice(source, line);
						});
			this.#writers.set(key, writer);
		}
		return writer;
	}

	/**
	 * A worker's start, crash or failure: an owner notice (redacted), with the stderr tail as Pi Mobile; a crash is
	 * "Worker exited (signal): tail" in the notice and the status error too, as in v1. A lost link Chord recovers from
	 * is only a log event.
	 */
	#failed(error: WorkersError): void {
		if (error.kind === "worker_exited") {
			// Chord reports the exit right before its `worker_failed`.
			const session = error.address.slice("session|".length);
			this.#exits.set(session, `Worker exited (${error.signal ?? error.code})`);
			this.#crashed(session);
			return;
		}
		if (error.kind === "worker_link_lost") {
			// Chord stopped the worker and its holders start a new one: an event, no notice.
			const session = error.address.slice("session|".length);
			const reason = processLogs.redactor.redact(
				error.error instanceof Error ? error.error.message : String(error.error),
			);
			processLogs.append(`${SESSION_PREFIX}${session}`, "event", `Worker lost its link (${reason}); restarting it`);
			return;
		}
		if (error.kind !== "worker_failed") {
			console.error("p2 workers:", error);
			return;
		}
		const session = error.address.slice("session|".length);
		const exit = this.#exits.get(session);
		this.#exits.delete(session);
		const reason = exit ?? (error.error instanceof Error ? error.error.message : String(error.error));
		const tail = error.stderrTail?.trim();
		const notice = processLogs.redactor.redact(`${reason}${tail ? `: ${tail}` : ""}`);
		this.#reasons.set(session, exit === undefined ? processLogs.redactor.redact(reason) : notice);
		processLogs.notice(`${SESSION_PREFIX}${session}`, notice);
	}

	/**
	 * A running worker exited unasked (SIGKILL, OOM): as in v1 its holders start a new one, up to
	 * `CRASH_RESTARTS` such restarts within `CRASH_WINDOW_MS`; a crash past that stays failed until Retry (no crash
	 * loop). A worker that crashes while starting stays failed too.
	 */
	#crashed(session: string): void {
		if (this.#states[`session|${session}`]?.status !== "running") return;
		const now = Date.now();
		const recent = (this.#crashRestarts.get(session) ?? []).filter((at) => now - at < CRASH_WINDOW_MS);
		const source = `${SESSION_PREFIX}${session}`;
		if (recent.length >= CRASH_RESTARTS) {
			this.#crashRestarts.set(session, recent);
			processLogs.append(
				source,
				"event",
				`Worker crashed ${recent.length + 1} times within a minute; waiting for Retry`,
			);
			return;
		}
		this.#crashRestarts.set(session, [...recent, now]);
		processLogs.append(source, "event", "Worker crashed; restarting it for its holders");
		// After the session's running steps (one may have restarted it already: then nothing is left to do). A stop
		// first: a holder's start already waiting on this exit fails with the crash, and a bare retry while that start
		// runs would be lost; the stop queues behind it, the retry after the stop starts the holders' worker.
		void this.#serially(session, async () => {
			if (this.#status(session) === "failed") await this.#stopped(session);
		});
	}

	/** Every change of the workers' states, as `HostEvent`s. */
	async #follow(): Promise<void> {
		const watch = await this.workers.state.watch(BACKGROUND_CONTEXT);
		const publish = (states: typeof watch.value): void => {
			for (const key of new Set([...Object.keys(this.#states), ...Object.keys(states)])) {
				const state = states[key];
				if (JSON.stringify(state) === JSON.stringify(this.#states[key])) continue;
				const session = key.slice("session|".length);
				const generation = this.generation(session);
				const event: HostEvent =
					state === undefined
						? { session, running: false, generation }
						: state.status === "failed"
							? {
									session,
									running: false,
									generation,
									error: this.#reasons.get(session) ?? processLogs.redactor.redact(state.error.message),
								}
							: { session, running: state.status === "running", generation, pid: state.pid };
				for (const listener of [...this.#listeners]) listener(event);
			}
			this.#states = states;
		};
		publish(watch.value);
		watch.start(async (call) => {
			if (call.kind === "value") publish(call.value);
		});
	}
}

/** `promise`, or a rejection once `ms` passed (`what` names it). */
function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
