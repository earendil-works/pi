// The connection loop (slice 11 §2, decision "Slice 11, P6"; p2's `keepConnected`): a client keeps one link to the
// server and replaces it when it ends. After a drop it reconnects after a growing pause (250 ms doubling to 5 s; a
// connection that stayed open 10 s resets it), at once on a wake (visible again, back online, network changed); it
// replaces an open socket silent past the server's ping interval on a wake, gives up a socket not open after 20 s, and
// stops when the app's `canRetry` says no (an outdated client, a guest's ended share). The environment (time, timers,
// wakes) is given, so the same loop runs in a page and in a terminal's sandbox.

/** The first retry pause after a failed or short-lived connection: 250 ms, doubling from there. */
export const RETRY_INITIAL_MS = 250;

/** The longest retry pause: 5 s (and the pause while offline). */
export const RETRY_MAX_MS = 5000;

/** A connection that stayed open this long counted as working: the next retry starts at the initial pause again. */
export const STABLE_MS = 10_000;

/** A socket not open after this long is given up (browsers have no handshake timeout). */
export const CONNECT_TIMEOUT_MS = 20_000;

/** The server's heartbeat pings every 15 s: an open socket silent for longer than this is presumed dead on a wake. */
export const STALE_MS = 25_000;

/** After a wake, messages held while the client was frozen get this long to arrive before the socket is judged. */
export const WAKE_GRACE_MS = 1000;

/** The connection as the app shows it: an attempt under way, open, or waiting for the next attempt. */
export type ConnectionState = "connecting" | "connected" | "waiting";

/** What one socket reports to the loop. */
export interface SocketEvents {
	opened(): void;
	/** Any frame: the server's pings keep an open socket from looking silent. */
	received(): void;
}

/** One attempt's connection as the loop sees it: it closes once, and closing it ends it at once. */
export interface LoopLink {
	onClose(listener: () => void): void;
	close(): void;
}

/** What the loop runs in: the clock, timers, whether the device is online, and its wake events. */
export interface LoopEnvironment {
	now(): number;
	/** Runs `callback` after `ms`; returns its cancel. */
	after(ms: number, callback: () => void): () => void;
	/** `false` when the device is known to be offline. */
	online(): boolean;
	/** Calls `listener` when the client may have been away (visible again, online, network changed); returns its removal. */
	onWake(listener: () => void): () => void;
}

/** What the loop takes. */
export type LoopOptions = {
	/** Opens one socket and its link; the socket reports to `events`. */
	readonly open: (events: SocketEvents) => LoopLink;
	readonly onState: (state: ConnectionState) => void;
	/** Asked after every close; `false` stops the loop. A rejection counts as `true` (unreachable, try again). */
	readonly canRetry: () => Promise<boolean>;
	readonly environment: LoopEnvironment;
};

/** Keeps a client connected until `stop`. */
export function keepConnected(options: LoopOptions): { stop(): void } {
	const loop = new Loop(options);
	loop.connect();
	return { stop: () => loop.stop() };
}

/** One attempt: its link, when it started and opened, its last frame, its timeout's cancel. */
type Attempt = {
	link: LoopLink | undefined;
	readonly startedAt: number;
	openedAt: number | undefined;
	lastFrame: number;
	cancelTimeout: () => void;
};

class Loop {
	readonly #options: LoopOptions;
	readonly #env: LoopEnvironment;
	readonly #removeWake: () => void;
	#failures = 0;
	#current: Attempt | undefined;
	#cancelRetry: (() => void) | undefined;
	#cancelStaleCheck: (() => void) | undefined;
	/** Between a close and `canRetry`'s answer; a wake meanwhile retries at once. */
	#deciding = false;
	#wokeWhileDeciding = false;
	#stopped = false;

	constructor(options: LoopOptions) {
		this.#options = options;
		this.#env = options.environment;
		this.#removeWake = this.#env.onWake(() => this.#wake());
	}

	/** Starts an attempt. */
	connect(): void {
		this.#cancelRetry = undefined;
		const env = this.#env;
		const attempt: Attempt = {
			link: undefined,
			startedAt: env.now(),
			openedAt: undefined,
			lastFrame: env.now(),
			cancelTimeout: () => {},
		};
		this.#current = attempt;
		this.#options.onState("connecting");
		const link = this.#options.open({
			opened: () => {
				if (this.#current !== attempt) return;
				attempt.openedAt = attempt.lastFrame = env.now();
				attempt.cancelTimeout();
				this.#options.onState("connected");
			},
			received: () => {
				attempt.lastFrame = env.now();
			},
		});
		attempt.link = link;
		attempt.cancelTimeout = env.after(CONNECT_TIMEOUT_MS, () => {
			if (attempt.openedAt === undefined) link.close();
		});
		link.onClose(() => this.#closed(attempt));
	}

	/** Stops the loop and closes the current link. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#removeWake();
		this.#cancelRetry?.();
		this.#cancelRetry = undefined;
		this.#current?.link?.close();
	}

	/** `attempt`'s link closed: asks `canRetry`, then schedules the next attempt. */
	#closed(attempt: Attempt): void {
		if (this.#current !== attempt) return;
		this.#current = undefined;
		attempt.cancelTimeout();
		this.#cancelStaleCheck?.();
		this.#cancelStaleCheck = undefined;
		if (this.#stopped) return;
		this.#options.onState("waiting");
		const { openedAt } = attempt;
		if (openedAt !== undefined && this.#env.now() - openedAt >= STABLE_MS) this.#failures = 0;
		this.#deciding = true;
		this.#wokeWhileDeciding = false;
		const decided = (retry: boolean): void => {
			this.#deciding = false;
			if (retry) this.#schedule(this.#wokeWhileDeciding);
		};
		this.#options.canRetry().then(decided, () => decided(true));
	}

	/** Schedules the next attempt: at once (`now`), else after the backoff (offline: the longest pause). */
	#schedule(now: boolean): void {
		if (this.#stopped) return;
		const backoff = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** this.#failures);
		this.#failures += 1;
		// Offline an attempt fails at once; the `online` wake retries sooner than this.
		const delay = now ? 0 : this.#env.online() ? backoff : RETRY_MAX_MS;
		this.#cancelRetry = this.#env.after(delay, () => this.connect());
	}

	/** A wake: a pending retry runs now; an open socket silent too long is replaced once its overdue ping is checked. */
	#wake(): void {
		if (this.#cancelRetry !== undefined) {
			this.#cancelRetry();
			this.connect();
			return;
		}
		if (this.#deciding) {
			this.#wokeWhileDeciding = true;
			return;
		}
		const attempt = this.#current;
		// A connecting attempt has its own timeout.
		if (attempt?.openedAt === undefined) return;
		this.#cancelStaleCheck?.();
		// After a network change the socket looks fine until the server's next ping is missing: check when it is due.
		const due = Math.max(WAKE_GRACE_MS, attempt.lastFrame + STALE_MS + 1 - this.#env.now());
		this.#cancelStaleCheck = this.#env.after(due, () => {
			this.#cancelStaleCheck = undefined;
			if (this.#current === attempt && this.#env.now() - attempt.lastFrame > STALE_MS) attempt.link?.close();
		});
	}
}
