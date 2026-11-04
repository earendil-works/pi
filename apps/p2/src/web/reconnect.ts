// The browser's connection loop: keeps one socket to the server, replaces it when it ends, and notices dead ones early.

/** Retry delays after a failed or short-lived connection: 250 ms, doubling, at most 5 s. */
export const RETRY_INITIAL_MS = 250;
export const RETRY_MAX_MS = 5000;
/** A connection that stayed open this long counted as working: the next retry starts again at the initial delay. */
export const STABLE_MS = 10_000;
/** A socket not open after this long is given up. Through Radius an upgrade may wait 15 s for the brain's side. */
export const CONNECT_TIMEOUT_MS = 20_000;
/** The server pings every 15 s: an open socket silent for longer than this is presumed dead. */
export const STALE_MS = 25_000;
/** After a wake, messages held while the page was frozen get this long to arrive before the socket is checked. */
export const WAKE_GRACE_MS = 1000;

/** What the page tells the loop about one socket. */
export interface SocketEvents {
	opened(): void;
	/** Any message: the server pings every 15 s, so silence means a dead connection. */
	received(): void;
	closed(code: number, reason: string, wasClean: boolean): void;
}

/** The link over one socket: it ends when the socket closes, and closing it ends it at once. */
export interface ReconnectLink {
	onClose(handler: (reason: string) => void): void;
	close(reason?: string): void;
}

export interface ReconnectEnvironment {
	now(): number;
	/** Runs `callback` after `ms`; returns a cancel function. */
	after(ms: number, callback: () => void): () => void;
	/** False when the device is known to be offline. */
	online(): boolean;
	/**
	 * `listener` runs when the page may have been away: back online, visible again, network changed, or restored.
	 * Returns a function that removes it.
	 */
	onWake(listener: () => void): () => void;
	log(message: string): void;
}

export interface ReconnectOptions {
	/** Opens a socket and its link; the socket reports to `events`. */
	open(events: SocketEvents): ReconnectLink;
	onConnected(connected: boolean): void;
	/** Asked after every close; false stops reconnecting (an outdated page, a guest's ended share). */
	canRetry(): Promise<boolean>;
	/**
	 * Replace an open socket after this long without a message, at any time, not only on wake. For sockets whose own
	 * protocol has no timeout (the terminal's); chord links time out by themselves.
	 */
	silenceTimeoutMs?: number;
	environment: ReconnectEnvironment;
}

type Attempt = {
	link: ReconnectLink | undefined;
	startedAt: number;
	/** When the socket opened; undefined while connecting. */
	openedAt: number | undefined;
	lastMessage: number;
	cancelTimeout: () => void;
	cancelWatch: () => void;
};

/**
 * Keeps the page connected until stopped:
 *
 * - After a close it retries with backoff. A connection that stayed open STABLE_MS resets the backoff; one that opens
 *   and ends at once (an older server refusing the protocol, for instance) keeps backing off instead of looping.
 * - An attempt not open after CONNECT_TIMEOUT_MS is given up: browsers have no handshake timeout.
 * - On wake (online, visible, network change, back/forward cache) a pending retry runs at once, and an open socket
 *   that has heard nothing for STALE_MS is replaced. After a network change the socket looks fine until the server's
 *   next ping is missing, so the check runs when that ping is overdue rather than only now.
 * - With `silenceTimeoutMs`, an open socket is also replaced whenever it stays silent that long. A check that runs
 *   late (a frozen or throttled page) first gives held messages WAKE_GRACE_MS to arrive.
 * - Every close is logged with its reason and close code: a 1006 that never opened is a refused handshake, one after
 *   opening a dropped connection.
 */
export function keepConnected(options: ReconnectOptions): { stop(): void } {
	const env = options.environment;
	let failures = 0;
	let current: Attempt | undefined;
	let cancelRetry: (() => void) | undefined;
	/** Between a close and the decision to retry (canRetry is asynchronous). */
	let deciding = false;
	let wokeWhileDeciding = false;
	let cancelStaleCheck: (() => void) | undefined;
	let stopped = false;

	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

	/** Replaces `attempt` once it is silent longer than `limit`; reschedules itself while messages keep arriving. */
	const watch = (attempt: Attempt, limit: number): void => {
		const scheduledAt = attempt.lastMessage + limit + 1;
		attempt.cancelWatch = env.after(Math.max(0, scheduledAt - env.now()), () => {
			if (current !== attempt) return;
			const now = env.now();
			const silent = now - attempt.lastMessage;
			if (silent <= limit) watch(attempt, limit);
			else if (now - scheduledAt > WAKE_GRACE_MS)
				attempt.cancelWatch = env.after(WAKE_GRACE_MS, () => {
					if (current !== attempt) return;
					if (env.now() - attempt.lastMessage <= limit) watch(attempt, limit);
					else attempt.link?.close(`no message from the server for ${seconds(env.now() - attempt.lastMessage)}`);
				});
			else attempt.link?.close(`no message from the server for ${seconds(silent)}`);
		});
	};

	const connect = (): void => {
		cancelRetry = undefined;
		const attempt: Attempt = {
			link: undefined,
			startedAt: env.now(),
			openedAt: undefined,
			lastMessage: env.now(),
			cancelTimeout: () => {},
			cancelWatch: () => {},
		};
		current = attempt;
		const link = options.open({
			opened: () => {
				if (current !== attempt) return;
				attempt.openedAt = attempt.lastMessage = env.now();
				attempt.cancelTimeout();
				if (options.silenceTimeoutMs !== undefined) watch(attempt, options.silenceTimeoutMs);
				options.onConnected(true);
			},
			received: () => {
				attempt.lastMessage = env.now();
			},
			closed: (code, reason, wasClean) => {
				const opened = attempt.openedAt === undefined ? "before opening" : "after opening";
				env.log(
					`Socket closed ${opened}: code ${code}${reason ? ` (${reason})` : ""}${wasClean ? "" : ", not clean"}`,
				);
			},
		});
		attempt.link = link;
		attempt.cancelTimeout = env.after(CONNECT_TIMEOUT_MS, () => {
			if (attempt.openedAt === undefined) link.close(`not open after ${seconds(CONNECT_TIMEOUT_MS)}`);
		});
		link.onClose((reason) => closed(attempt, reason));
	};

	const closed = (attempt: Attempt, reason: string): void => {
		if (current !== attempt) return;
		current = undefined;
		attempt.cancelTimeout();
		attempt.cancelWatch();
		cancelStaleCheck?.();
		cancelStaleCheck = undefined;
		if (stopped) return;
		options.onConnected(false);
		const now = env.now();
		if (attempt.openedAt === undefined)
			env.log(`Connection failed after ${seconds(now - attempt.startedAt)}: ${reason}`);
		else env.log(`Connection lost after ${seconds(now - attempt.openedAt)} open: ${reason}`);
		if (attempt.openedAt !== undefined && now - attempt.openedAt >= STABLE_MS) failures = 0;
		deciding = true;
		wokeWhileDeciding = false;
		void options.canRetry().then(
			(retry) => {
				deciding = false;
				if (retry) schedule(wokeWhileDeciding);
			},
			() => {
				deciding = false;
				schedule(wokeWhileDeciding);
			},
		);
	};

	const schedule = (now: boolean): void => {
		if (stopped) return;
		const backoff = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** failures);
		failures += 1;
		// Offline, an attempt fails at once; the `online` wake retries sooner than this.
		const delay = now ? 0 : env.online() ? backoff : RETRY_MAX_MS;
		cancelRetry = env.after(delay, connect);
	};

	const wake = (): void => {
		if (cancelRetry) {
			cancelRetry();
			connect();
			return;
		}
		if (deciding) {
			wokeWhileDeciding = true;
			return;
		}
		const attempt = current;
		// A connecting attempt has its own timeout.
		if (attempt?.openedAt === undefined) return;
		cancelStaleCheck?.();
		const check = (): void => {
			cancelStaleCheck = undefined;
			const silent = env.now() - attempt.lastMessage;
			if (current === attempt && silent > STALE_MS)
				attempt.link?.close(`no message from the server for ${seconds(silent)}`);
		};
		cancelStaleCheck = env.after(Math.max(WAKE_GRACE_MS, attempt.lastMessage + STALE_MS + 1 - env.now()), check);
	};

	const removeWake = env.onWake(wake);
	connect();
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			removeWake();
			cancelRetry?.();
			cancelRetry = undefined;
			current?.link?.close("stopped");
		},
	};
}

/**
 * The page's environment: wakes on `online`, visibility, network changes (where reported) and back/forward restores.
 * Logs go to the console under `name`.
 */
export function browserEnvironment(name: string): ReconnectEnvironment {
	return {
		now: () => Date.now(),
		after: (ms, callback) => {
			const timer = setTimeout(callback, ms);
			return () => clearTimeout(timer);
		},
		online: () => navigator.onLine,
		onWake: (listener) => {
			const pageshow = (event: PageTransitionEvent) => {
				if (event.persisted) listener();
			};
			const visibility = () => {
				if (document.visibilityState === "visible") listener();
			};
			// Chromium only: Wi-Fi to cellular and back, which leaves the old socket dead without telling anyone.
			const network = (navigator as { connection?: EventTarget }).connection;
			window.addEventListener("online", listener);
			window.addEventListener("pageshow", pageshow);
			document.addEventListener("visibilitychange", visibility);
			network?.addEventListener("change", listener);
			return () => {
				window.removeEventListener("online", listener);
				window.removeEventListener("pageshow", pageshow);
				document.removeEventListener("visibilitychange", visibility);
				network?.removeEventListener("change", listener);
			};
		},
		log: (message) => console.info(`[${name}] ${message}`),
	};
}
