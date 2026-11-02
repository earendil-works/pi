// The workers component (slice 10 §3, §4; decision "Slice 10's points"): a forked worker process per address of one
// host kind, started on demand by the route it owns, stopped when idle, never restarted by itself (R2): a crash, a
// `fatal`, a link lost while its child lives or a failed start leaves the address failed until `retry` or a rollout.
// Per address, a child's events are recorded on that child as they happen; starts and stops run one after another.

import type { Context } from "../../context/index.ts";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Address, HostKind, KindShape } from "../../next/contracts/index.ts";
import type { Params } from "../../next/contracts/internal.ts";
import { ChordError, type Principal } from "../../next/data/index.ts";
import type { Host, RouteHandle } from "../../next/host/index.ts";
import { Batch, type BatchError, Source } from "../../next/state/internal.ts";
import type { Watchable } from "../../watch.ts";
import type { Plugins, RolloutHost, RolloutStep } from "../plugins/plugins.ts";
import type { PluginScript } from "../plugins/runtime.ts";
import { type CrossedError, type CrossedReport, type FromWorker, uncrossed, uncrossedReport } from "./control.ts";
import { type Exit, WorkerProcess } from "./process.ts";

/** What `createWorkers` takes. `kind`, `entry`, `execArgv` and `env` are bootstrap; the functions are called per use. */
export type WorkersOptions<P extends Principal, K extends KindShape> = {
	/** The facet kind its workers load (`"worker"`), shipped by the plugins component. */
	readonly kind: string;
	/** The worker's entry module (it calls `workerMain`), its Node flags and its environment. */
	readonly entry: string;
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** The route's `authorize`: whether `principal` may reach `address` (synchronous). */
	readonly authorize: (principal: P, address: Address<K>) => boolean;
	/** Who the worker at `address` is (stamped on its link). */
	readonly principal: (address: Address<K>) => P;
	/** The worker's start data (JSON), before each start; abortable (`close`), a throw fails the start. */
	readonly start: (address: Address<K>, context: Context) => Promise<JsonValue> | JsonValue;
	/** The lock one live worker of `address` holds (across processes). */
	readonly lock: (address: Address<K>) => string;
	/** How long a worker idles before it is stopped: 5 minutes by default. */
	readonly idleMs?: () => number;
	readonly plugins: Plugins;
	/** A worker's output; without it, mirrored to this process's own. */
	readonly onOutput?: (address: Address<K>, stream: "stdout" | "stderr", chunk: Uint8Array) => void;
	readonly onError: (error: WorkersError) => void;
};

/**
 * One address's worker (R5): running or on its way, or failed (until `retry` or a rollout) with a public error: a fixed
 * message (`worker failed to start`, `worker exited (SIGSEGV)`) or the child's redacted `fatal`.
 */
export type WorkerState =
	| { readonly status: "starting" | "running" | "stopping"; readonly pid: number; readonly startedAt: number }
	| { readonly status: "failed"; readonly error: CrossedError; readonly at: number };

/** What the component reports (and the state's watch listeners that threw). */
export type WorkersError =
	| {
			readonly kind: "worker_failed";
			readonly address: string;
			/** The full error (a start's throw, a crash, the child's `fatal`): for the app's logs, never public. */
			readonly error: unknown;
			readonly stderrTail?: string;
	  }
	| {
			/** The app's `authorize` threw: the hold is refused (`forbidden`), the error stays private. */
			readonly kind: "authorize_failed";
			readonly address: string;
			readonly error: unknown;
	  }
	| {
			readonly kind: "worker_exited";
			readonly address: string;
			readonly code: number | null;
			readonly signal: string | null;
	  }
	| BatchError;

/** The workers component. */
export interface Workers<K extends KindShape> {
	/** Per address key its `WorkerState`; no entry when stopped or never started. A JSON watchable. */
	readonly state: Watchable<Readonly<Record<string, WorkerState>>>;
	/** Suspends `address` while it has holders (`RouteHandle.suspend`), then stops its worker. */
	stop(address: Address<K>, context: Context): Promise<void>;
	/** Clears `address`'s failure and suspension: it starts again now if held (`RouteHandle.retry`). */
	retry(address: Address<K>, context: Context): Promise<void>;
	/** A rollout step shipping the kind's current set to every worker, one result per worker (§4). */
	step(name: string): RolloutStep;
	/** Cancels starts, stops every worker; new starts reject `released/closed`. */
	close(context: Context): Promise<void>;
}

/** Creates the workers component on `host`: it routes `Kind` itself (`host.route`, before `load`). */
export function createWorkers<P extends Principal, N extends string, Q extends Params>(
	host: Host<P>,
	Kind: HostKind<N, Q>,
	options: WorkersOptions<P, HostKind<N, Q>>,
	context: Context,
): Workers<HostKind<N, Q>> {
	// Its addresses are `Address<HostKind<N, Q>>`, as the route hands them over.
	const component = new WorkersComponent(options as unknown as WorkersOptions<Principal, HostKind>, context);
	const route = host.route(
		Kind,
		{
			authorize: (principal, address) => {
				// A throw would reach the holder as the hold's failure: the app's error stays private.
				try {
					return options.authorize(principal, address);
				} catch (error) {
					options.onError({ kind: "authorize_failed", address: address.key, error });
					return false;
				}
			},
			// The principal is `options.principal`'s, a `P`.
			resolve: (address, routing) =>
				component.resolve(address, routing) as Promise<{ link: Link; principal: P; trusted: true }>,
		},
		context,
	);
	component.route = route as unknown as RouteHandle<HostKind>;
	return component as unknown as Workers<HostKind<N, Q>>;
}

/**
 * A failure an address keeps until `retry` or a rollout: what the public sees (a fixed message, or the child's redacted
 * `fatal`; decision "Slice 10 fix round, worker errors in public") and when.
 */
type Failure = { readonly error: CrossedError; readonly at: number };

/**
 * Why a child fails when it exits, recorded as it happens: a start that failed, a `fatal`, a lost link. `error` is the
 * full error (`onError` only); `public` what holders and `state` get (a fixed one from the exit when absent).
 */
type Cause = {
	readonly error: unknown;
	readonly public?: CrossedError;
	/** The component ended the child itself (a failed start): its exit is no `worker_exited`. */
	readonly killed?: true;
};

/** How a child's reloads end once it is gone: stopped cleanly (a stop's exit) or with an error. */
type Ended = { readonly kind: "stopped" } | { readonly kind: "failed"; readonly error: unknown };

/** One worker process of an address, with what its events recorded. */
type Child = {
	readonly process: WorkerProcess;
	status: "starting" | "running" | "stopping";
	/** A stop was asked for: its exit is no crash. */
	stopping: boolean;
	cause: Cause | undefined;
	/** `started`: the app's host listens on its link. */
	readonly started: PromiseWithResolvers<void>;
	/** `ready`: its load report; rejected when it exits before. */
	readonly ready: PromiseWithResolvers<CrossedReport>;
	/** Since when it is idle (from `ready`); `undefined` while busy or before `ready`. */
	idleSince: number | undefined;
	/** An idle stop is queued (checked again when it runs). */
	idleStop: boolean;
	/** The set its start message or its last reload that applied without failures carried. */
	shipped: string;
	/** Its reloads, one outstanding at a time; settles to nothing (a report kept as its value would stay alive). */
	reloading: Promise<void>;
	/** The waiter of its outstanding reload. */
	reloaded: ((reply: Extract<FromWorker, { readonly kind: "reloaded" }>) => void) | undefined;
	/** Set once its link is gone or it exited: every reload queued behind settles with it. */
	ended: Ended | undefined;
	/** The grace timer of a stop or of a lost link. */
	grace: ReturnType<typeof setTimeout> | undefined;
};

/** One address: its operations in a queue, its child, its failure. Kept while it has any of them. */
type Routed = {
	readonly address: Address<HostKind>;
	queue: Promise<void>;
	pending: number;
	child: Child | undefined;
	failure: Failure | undefined;
	/** A start was queued and has not settled. */
	starting: Promise<unknown> | undefined;
};

/** Starts a worker may take until `started` (fork, lock, connect): 60 s. */
const START_TIMEOUT = 60_000;

/** How long a stopping worker (or one whose link is gone) gets before its tree is killed: 5 s. */
const GRACE = 5_000;

/** How often idle workers are looked for: every second. */
const IDLE_CHECK = 1_000;

/** How long a worker idles before it is stopped unless `idleMs` says otherwise: 5 minutes. */
const IDLE_MS = 5 * 60_000;

/** The public error of a start that failed. */
const START_FAILED: CrossedError = { message: "worker failed to start", code: "unavailable" };

/** The link type a route's `resolve` returns. */
type Link = WorkerProcess["link"];

class WorkersComponent implements Workers<HostKind> {
	/** Set by `createWorkers` once the route exists. */
	route!: RouteHandle<HostKind>;
	readonly state: Watchable<Readonly<Record<string, WorkerState>>>;
	readonly #state: WorkersState;
	readonly #options: WorkersOptions<Principal, HostKind>;
	readonly #addresses = new Map<string, Routed>();
	/** Aborted at `close`: starts waiting in the app's `start` or for `started` end. */
	readonly #closing = new AbortController();
	/** `#closing`'s signal as a context: what a start's waits are bounded by. */
	readonly #closingContext = withAbortSignal(this.#closing.signal, BACKGROUND_CONTEXT);
	/** Whether the route's context closes it already (its first `resolve` attached that). */
	#routing = false;
	#idleTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: WorkersOptions<Principal, HostKind>, context: Context) {
		this.#options = options;
		this.#state = new WorkersState(this.#addresses, new Batch((error) => options.onError(error), undefined));
		// Its value is a `Record<string, WorkerState>`.
		this.state = this.#state as unknown as Watchable<Readonly<Record<string, WorkerState>>>;
		this.#closeWith(context);
	}

	/**
	 * The route's `resolve`: a failed address rejects at once with its (public) failure, nothing forks; otherwise a
	 * start, after the previous child's exit.
	 */
	resolve(address: Address<HostKind>, routing: Context): Promise<{ link: Link; principal: Principal; trusted: true }> {
		if (!this.#routing) {
			this.#routing = true;
			this.#closeWith(routing);
		}
		const routed = this.#routed(address);
		if (routed.failure !== undefined) return Promise.reject(uncrossed(routed.failure.error));
		if (this.#closing.signal.aborted) return Promise.reject(closed());
		const started = this.#enqueue(routed, () => this.#start(routed, routing));
		routed.starting = started;
		void started.then(
			() => this.#settled(routed, started),
			() => this.#settled(routed, started),
		);
		return started;
	}

	async stop(address: Address<HostKind>, context: Context): Promise<void> {
		this.route.suspend(address);
		const routed = this.#addresses.get(address.key);
		if (routed === undefined) return;
		await awaitWithContext(
			this.#enqueue(routed, () => this.#stop(routed)),
			context,
		);
	}

	async retry(address: Address<HostKind>, _context: Context): Promise<void> {
		const routed = this.#addresses.get(address.key);
		if (routed !== undefined) {
			routed.failure = undefined;
			this.#state.refresh();
			this.#forget(routed);
		}
		this.route.retry(address);
	}

	step(name: string): RolloutStep {
		return { name, kinds: [this.#options.kind], reload: (_built, context) => this.#rollout(context) };
	}

	async close(context: Context): Promise<void> {
		if (!this.#closing.signal.aborted) this.#closing.abort(closed());
		clearInterval(this.#idleTimer);
		this.#idleTimer = undefined;
		const stops = [...this.#addresses.values()].map((routed) => this.#enqueue(routed, () => this.#stop(routed)));
		await awaitWithContext(Promise.all(stops), context);
	}

	/** `context`'s abort closes the component (the route's is aborted when the host closes). */
	#closeWith(context: Context): void {
		const signal = context.abortSignal;
		if (signal === undefined || signal.aborted) return;
		signal.addEventListener("abort", () => void this.close(BACKGROUND_CONTEXT).catch(() => {}), { once: true });
	}

	/** The record of `address`, made by its first use. */
	#routed(address: Address<HostKind>): Routed {
		let routed = this.#addresses.get(address.key);
		if (routed === undefined) {
			routed = {
				address,
				queue: Promise.resolve(),
				pending: 0,
				child: undefined,
				failure: undefined,
				starting: undefined,
			};
			this.#addresses.set(address.key, routed);
		}
		return routed;
	}

	/** Runs `operation` after the address's earlier ones. */
	#enqueue<T>(routed: Routed, operation: () => Promise<T>): Promise<T> {
		routed.pending++;
		const run = routed.queue.then(operation);
		routed.queue = run.then(
			() => this.#done(routed),
			() => this.#done(routed),
		);
		return run;
	}

	/** An operation ended. */
	#done(routed: Routed): void {
		routed.pending--;
		this.#forget(routed);
	}

	/** A start settled: no longer starting. */
	#settled(routed: Routed, started: Promise<unknown>): void {
		if (routed.starting === started) routed.starting = undefined;
	}

	/** Forgets an address with no operation, no child and no failure. */
	#forget(routed: Routed): void {
		if (routed.pending === 0 && routed.child === undefined && routed.failure === undefined) {
			this.#addresses.delete(routed.address.key);
		}
	}

	/**
	 * A start: the app's start data, the fork, the start message with the kind's current set, then `started` within the
	 * start timer (fork, lock and connect only). Its failure fails the address; `close` ends it at any of its waits (an
	 * app's `start` that ignores its signal too), a forked child is stopped.
	 */
	async #start(routed: Routed, routing: Context): Promise<{ link: Link; principal: Principal; trusted: true }> {
		const { address } = routed;
		// After the previous child's exit (its link may close first): a crash recorded meanwhile rejects this start.
		await routed.child?.process.exited;
		const crashed = routed.failure;
		if (crashed !== undefined) throw uncrossed(crashed.error);
		if (this.#closing.signal.aborted) throw closed();
		const context = withAbortSignal(this.#closing.signal, routing);
		let data: JsonValue;
		try {
			data = await awaitWithContext(Promise.resolve(this.#options.start(address, context)), this.#closingContext);
		} catch (error) {
			if (this.#closing.signal.aborted) throw closed();
			throw this.#fail(routed, { error, public: START_FAILED }, undefined);
		}
		if (this.#closing.signal.aborted) throw closed();
		let child: Child;
		try {
			child = this.#fork(routed);
		} catch (error) {
			throw this.#fail(routed, { error, public: START_FAILED }, undefined);
		}
		const timer = setTimeout(() => {
			const error = new Error(`worker ${address.key}: did not start within ${START_TIMEOUT / 1000} s`);
			child.cause ??= { error, killed: true };
			child.process.kill();
		}, START_TIMEOUT);
		// Every app hook of the start runs in here: what one throws stays private (`worker_failed`), its holders and
		// `state` get the fixed public message (Astra's recheck R3: `principal` threw through to a guest).
		try {
			const scripts = await this.#options.plugins.scripts(this.#options.kind, context);
			child.shipped = keyOf(scripts);
			const lock = this.#options.lock(address);
			child.process.send({ kind: "start", address, start: data, scripts, lock });
			await awaitWithContext(child.started.promise, this.#closingContext);
			return { link: child.process.link, principal: this.#options.principal(address), trusted: true };
		} catch (error) {
			// Closing is a stop (no failure); anything else fails the start.
			if (this.#closing.signal.aborted) child.stopping = true;
			else child.cause ??= { error, public: START_FAILED, killed: true };
			child.process.kill();
			await child.process.exited;
			if (this.#closing.signal.aborted) throw closed();
			throw uncrossed(routed.failure?.error ?? START_FAILED);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Forks the address's worker and records its events on it as they happen. */
	#fork(routed: Routed): Child {
		const { address } = routed;
		const onOutput = this.#options.onOutput;
		let child!: Child;
		const process = new WorkerProcess(
			{
				entry: this.#options.entry,
				...(this.#options.execArgv === undefined ? {} : { execArgv: this.#options.execArgv }),
				...(this.#options.env === undefined ? {} : { env: this.#options.env }),
				...(onOutput === undefined ? {} : { onOutput: (stream, chunk) => onOutput(address, stream, chunk) }),
			},
			{
				control: (message) => this.#control(routed, child, message),
				linkLost: () => this.#linkLost(child),
				linkClosed: () => this.#linkClosed(child),
				exited: (exit) => this.#exited(routed, child, exit),
			},
		);
		child = {
			process,
			status: "starting",
			stopping: false,
			cause: undefined,
			started: Promise.withResolvers(),
			ready: Promise.withResolvers(),
			idleSince: undefined,
			idleStop: false,
			shipped: "",
			reloading: Promise.resolve(),
			reloaded: undefined,
			ended: undefined,
			grace: undefined,
		};
		// Nobody may wait for them.
		child.started.promise.catch(() => {});
		child.ready.promise.catch(() => {});
		routed.child = child;
		this.#state.refresh();
		this.#watchIdle();
		return child;
	}

	/** A control message of `child`. */
	#control(routed: Routed, child: Child, message: FromWorker): void {
		switch (message.kind) {
			case "started":
				child.started.resolve();
				return;
			case "ready":
				child.status = "running";
				child.idleSince = message.idle ? Date.now() : undefined;
				child.ready.resolve(message.report);
				if (routed.child === child) this.#state.refresh();
				return;
			case "idle":
				child.idleSince = message.idle ? (child.idleSince ?? Date.now()) : undefined;
				return;
			case "fatal":
				// Redacted by the child's `redact`: public as it is.
				child.cause ??= { error: uncrossed(message.error), public: message.error };
				child.started.reject(uncrossed(message.error));
				child.process.kill();
				return;
			case "reloaded":
				child.reloaded?.(message);
		}
	}

	/** This side closed `child`'s link (the heartbeat, a protocol error): its child is stopped, its exit a crash. */
	#linkLost(child: Child): void {
		this.#ended(child);
		if (child.stopping) return;
		child.cause ??= { error: new Error("worker: link lost") };
		this.#shutdown(child);
		this.#state.refresh();
	}

	/**
	 * The child's side closed its link (it is exiting, or it closed its IPC and lives on): its reloads end; one that does
	 * not exit within the grace is killed, its exit a crash (link lost).
	 */
	#linkClosed(child: Child): void {
		this.#ended(child);
		if (child.stopping || child.grace !== undefined) return;
		child.grace = setTimeout(() => {
			child.cause ??= { error: new Error("worker: link lost") };
			child.process.kill();
		}, GRACE);
	}

	/**
	 * `child` exited: a stop's exit forgets it; any other is a crash that fails the address (`worker_exited` and
	 * `worker_failed` once, the full error and stderr tail for the app's logs only), except once the component closes.
	 */
	#exited(routed: Routed, child: Child, exit: Exit): void {
		clearTimeout(child.grace);
		const clean = child.stopping && child.cause === undefined;
		const cause: Cause = child.cause ?? { error: exitError(routed.address, exit, child) };
		const error = cause.public ?? publicExit(exit, child);
		child.started.reject(uncrossed(error));
		child.ready.reject(uncrossed(error));
		this.#ended(child);
		if (routed.child !== child) return;
		routed.child = undefined;
		if (!clean && !this.#closing.signal.aborted) {
			const { code, signal } = exit;
			// A failed start's kill is the component's own act (Opus's second recheck): only `worker_failed`.
			if (cause.killed !== true) {
				this.#options.onError({ kind: "worker_exited", address: routed.address.key, code, signal });
			}
			this.#fail(routed, { ...cause, public: error }, child.process.stderrTail);
		}
		this.#state.refresh();
		this.#forget(routed);
	}

	/**
	 * `child`'s link is gone or it exited (the first of these): its outstanding reload and every one queued behind it
	 * settle, `stopped` when a stop asked for it, else failed.
	 */
	#ended(child: Child): void {
		if (child.ended !== undefined) return;
		child.ended =
			child.stopping && child.cause === undefined
				? { kind: "stopped" }
				: { kind: "failed", error: new ChordError({ code: "unavailable", message: "worker: its link is gone" }) };
		child.reloaded?.({ kind: "reloaded", error: { message: "worker: its link is gone" } });
	}

	/**
	 * Fails `routed` with `cause` (`worker_failed` once, with the full error and `stderrTail`); returns the public error
	 * a start rejects with.
	 */
	#fail(routed: Routed, cause: Cause & { readonly public: CrossedError }, stderrTail: string | undefined): Error {
		routed.failure = { error: cause.public, at: Date.now() };
		this.#options.onError({
			kind: "worker_failed",
			address: routed.address.key,
			error: cause.error,
			...(stderrTail === undefined ? {} : { stderrTail }),
		});
		this.#state.refresh();
		return uncrossed(cause.public);
	}

	/** A stop: `shutdown`, the grace, then the tree killed; resolves at its exit. */
	async #stop(routed: Routed): Promise<void> {
		const child = routed.child;
		if (child === undefined) return;
		child.stopping = true;
		this.#shutdown(child);
		this.#state.refresh();
		await child.process.exited;
	}

	/** Asks `child` to shut down and kills its tree after the grace. */
	#shutdown(child: Child): void {
		child.status = "stopping";
		child.process.send({ kind: "shutdown" });
		clearTimeout(child.grace);
		child.grace = setTimeout(() => child.process.kill(), GRACE);
	}

	/** Starts the idle check (every second) while any worker exists. */
	#watchIdle(): void {
		if (this.#idleTimer !== undefined) return;
		this.#idleTimer = setInterval(() => this.#checkIdle(), IDLE_CHECK);
		this.#idleTimer.unref();
	}

	/** Queues a stop for every worker idle since `idleMs()`; stops checking once no worker is left. */
	#checkIdle(): void {
		const idleMs = this.#idleMs();
		const now = Date.now();
		let workers = 0;
		for (const routed of this.#addresses.values()) {
			const child = routed.child;
			if (child === undefined) continue;
			workers++;
			if (child.idleStop || child.status !== "running") continue;
			if (child.idleSince === undefined || now - child.idleSince < idleMs) continue;
			child.idleStop = true;
			void this.#enqueue(routed, () => this.#idleStop(routed, child));
		}
		if (workers === 0) {
			clearInterval(this.#idleTimer);
			this.#idleTimer = undefined;
		}
	}

	/** An idle stop when it runs: only if `child` is still the address's and still idle (a hold may have come since). */
	async #idleStop(routed: Routed, child: Child): Promise<void> {
		child.idleStop = false;
		if (routed.child !== child || child.idleSince === undefined) return;
		if (Date.now() - child.idleSince < this.#idleMs()) return;
		await this.#stop(routed);
	}

	/** How long a worker idles before it is stopped. */
	#idleMs(): number {
		return this.#options.idleMs?.() ?? IDLE_MS;
	}

	/**
	 * The rollout step (§4): the set as this rollout applied it, read now (before another rollout changes it); the
	 * failures recorded before it cleared and the held ones retried (listed once ready or failed); the set shipped to
	 * every worker whose last applied set differs, in parallel. `context`'s abort ends only this wait: the entries
	 * still waiting are listed with its error.
	 */
	async #rollout(context: Context): Promise<{ readonly hosts: readonly RolloutHost[] }> {
		const { kind, plugins } = this.#options;
		const scripts = plugins.current(kind) ?? (await plugins.scripts(kind, context));
		const key = keyOf(scripts);
		const entries: { readonly host: string; readonly entry: Promise<RolloutHost> }[] = [];
		for (const routed of [...this.#addresses.values()]) {
			if (routed.failure === undefined) continue;
			routed.failure = undefined;
			this.#state.refresh();
			this.route.retry(routed.address);
			const started = routed.starting;
			if (started === undefined) this.#forget(routed);
			else entries.push({ host: routed.address.key, entry: this.#retried(routed, started) });
		}
		for (const routed of this.#addresses.values()) {
			const child = routed.child;
			if (child === undefined || child.status === "stopping" || child.shipped === key) continue;
			entries.push({ host: routed.address.key, entry: this.#reload(routed.address.key, child, scripts, key) });
		}
		return { hosts: await Promise.all(entries.map(({ host, entry }) => bounded(host, entry, context))) };
	}

	/** A retried address's entry: its start's load report once ready, or its error. */
	async #retried(routed: Routed, started: Promise<unknown>): Promise<RolloutHost> {
		const host = routed.address.key;
		try {
			await started;
			const child = routed.child;
			if (child === undefined) throw new Error("worker: exited");
			return { host, report: uncrossedReport(await child.ready.promise) };
		} catch (error) {
			return { host, error };
		}
	}

	/**
	 * Ships `scripts` to `child` after its outstanding reload; settles on `reloaded`, its link's loss or its exit. Only a
	 * reload that applied without failures marks the set shipped (a failed plugin is shipped again next time).
	 */
	#reload(host: string, child: Child, scripts: readonly PluginScript[], key: string): Promise<RolloutHost> {
		const reload = child.reloading.then(
			() =>
				new Promise<RolloutHost>((resolve) => {
					const settle = (ended: Ended): void => {
						resolve(ended.kind === "stopped" ? { host, stopped: true } : { host, error: ended.error });
					};
					if (child.ended !== undefined) {
						settle(child.ended);
						return;
					}
					child.reloaded = (reply) => {
						child.reloaded = undefined;
						if ("report" in reply) {
							if (reply.report.failed.length === 0) child.shipped = key;
							resolve({ host, report: uncrossedReport(reply.report) });
						} else if (child.ended !== undefined) {
							settle(child.ended);
						} else {
							resolve({ host, error: uncrossed(reply.error) });
						}
					};
					child.process.send({ kind: "reload", scripts });
				}),
		);
		child.reloading = reload.then(
			() => {},
			() => {},
		);
		return reload;
	}
}

/** What new starts reject with once the component closes. */
function closed(): ChordError {
	return new ChordError({ code: "released", reason: "closed", message: "workers: closed" });
}

/** The full error of an exit nobody asked for (the app's logs). */
function exitError(address: Address, { code, signal }: Exit, child: Child): Error {
	const how = signal === null ? `code ${code}` : `signal ${signal}`;
	const when = child.status === "starting" ? "exited before it was ready" : "exited";
	return new ChordError({ code: "unavailable", message: `worker ${address.key}: ${when} (${how})` });
}

/** The public error of an exit: a start that failed, or the exit's code or signal. */
function publicExit({ code, signal }: Exit, child: Child): CrossedError {
	if (child.status === "starting") return START_FAILED;
	return { message: `worker exited (${signal ?? `code ${code}`})`, code: "unavailable" };
}

/** A set's identity: its plugins and digests. */
function keyOf(scripts: readonly PluginScript[]): string {
	return scripts
		.map(({ plugin, built }) => `${plugin.name}@${built.kind === "script" ? built.digest : "failed"}`)
		.sort()
		.join("\n");
}

/** `entry`, or `host` listed with the abort's error once `context` aborts first (the entry goes on). */
async function bounded(host: string, entry: Promise<RolloutHost>, context: Context): Promise<RolloutHost> {
	try {
		return await awaitWithContext(entry, context);
	} catch (error) {
		return { host, error };
	}
}

/** The workers' state: a JSON watchable of every address's `WorkerState`, published once per microtask turn. */
class WorkersState extends Source {
	readonly #addresses: ReadonlyMap<string, Routed>;
	#value: Readonly<Record<string, WorkerState>> | undefined;
	#scheduled = false;

	constructor(addresses: ReadonlyMap<string, Routed>, batch: Batch) {
		super(batch);
		this.#addresses = addresses;
	}

	get value(): JsonValue {
		this.#value ??= stateOf(this.#addresses);
		// Plain JSON: statuses, numbers and crossed errors.
		return this.#value as unknown as JsonValue;
	}

	deliver(context: Context): void {
		const value = this.value;
		this.publish(value, [["r", value]], false, context);
	}

	/** Something changed: published with the turn's other changes while someone watches or derives from it. */
	refresh(): void {
		this.#value = undefined;
		if (this.#scheduled || (!this.watched && this.dependents.size === 0)) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}
}

/** Every address's state: its child's, or its failure; none for an address with neither. */
function stateOf(addresses: ReadonlyMap<string, Routed>): Record<string, WorkerState> {
	const state: Record<string, WorkerState> = {};
	for (const [key, { child, failure }] of addresses) {
		if (failure !== undefined) {
			state[key] = { status: "failed", ...failure };
		} else if (child !== undefined) {
			const { pid, startedAt } = child.process;
			state[key] = { status: child.status, pid, startedAt };
		}
	}
	return state;
}
