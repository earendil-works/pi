// Tests of the connection loop (slice 11 §2, decision "Slice 11, P6"): reconnect pauses (250 ms doubling to 5 s, reset
// by a stable connection, the longest while offline), wakes (a pending retry at once, a drop soon after one retried at
// once; an open socket silent past the server's pings replaced), the connect timeout, `canRetry` asked beside the next
// attempt and stopping it, and the states it reports.

import { describe, expect, it } from "vitest";
import {
	CONNECT_TIMEOUT_MS,
	type ConnectionState,
	keepConnected,
	type LoopEnvironment,
	type SocketEvents,
	STABLE_MS,
	STALE_MS,
} from "../../src/surfaces/connection.ts";

/** A clock and timers the test advances, wakes it sends, and the sockets the loop opened. */
class FakeWorld {
	now = 0;
	online = true;
	readonly #timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
	#wake: (() => void) | undefined;
	readonly sockets: FakeSocket[] = [];
	readonly opens: number[] = [];

	readonly environment: LoopEnvironment = {
		now: () => this.now,
		after: (ms, callback) => {
			const timer = { at: this.now + ms, callback, cancelled: false };
			this.#timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		online: () => this.online,
		onWake: (listener) => {
			this.#wake = listener;
			return () => {
				this.#wake = undefined;
			};
		},
	};

	open = (events: SocketEvents): FakeSocket => {
		const socket = new FakeSocket(events);
		this.sockets.push(socket);
		this.opens.push(this.now);
		return socket;
	};

	/** Advances the clock by `ms`, running due timers in order; settles promises after each. */
	async advance(ms: number): Promise<void> {
		const end = this.now + ms;
		for (;;) {
			await settled();
			const due = this.#timers.filter(({ at, cancelled }) => !cancelled && at <= end).sort((a, b) => a.at - b.at)[0];
			if (due === undefined) break;
			this.now = due.at;
			due.cancelled = true;
			due.callback();
		}
		this.now = end;
		await settled();
	}

	wake(): void {
		this.#wake?.();
	}

	get last(): FakeSocket {
		return this.sockets.at(-1)!;
	}
}

/** One socket and its link: the test opens, feeds and closes it. */
class FakeSocket {
	readonly events: SocketEvents;
	closed = false;
	#onClose: (() => void) | undefined;

	constructor(events: SocketEvents) {
		this.events = events;
	}

	onClose(listener: () => void): void {
		this.#onClose = listener;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.#onClose?.();
	}
}

async function settled(): Promise<void> {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}

/** A loop in `world` recording its states; `retry` answers `canRetry`. */
function loop(world: FakeWorld, retry: () => Promise<boolean> = async () => true) {
	const states: ConnectionState[] = [];
	const handle = keepConnected({
		open: world.open,
		onState: (state) => states.push(state),
		canRetry: retry,
		environment: world.environment,
	});
	return { states, handle };
}

describe("reconnecting", () => {
	it("reconnects after a growing pause, 250 ms doubling to 5 s, and reports its states", async () => {
		const world = new FakeWorld();
		const { states } = loop(world);
		const pauses: number[] = [];
		for (let attempt = 0; attempt < 7; attempt++) {
			const closedAt = world.now;
			world.last.close();
			await world.advance(5000);
			pauses.push(world.opens.at(-1)! - closedAt);
		}
		expect(pauses).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
		expect(states.slice(0, 4)).toEqual(["connecting", "waiting", "connecting", "waiting"]);
	});

	it("starts the pauses again after a connection that stayed open 10 s", async () => {
		const world = new FakeWorld();
		const { states } = loop(world);
		for (let attempt = 0; attempt < 3; attempt++) {
			world.last.close();
			await world.advance(5000);
		}
		world.last.events.opened();
		expect(states.at(-1)).toBe("connected");
		await world.advance(STABLE_MS);
		const before = world.now;
		world.last.close();
		await world.advance(5000);
		expect(world.opens.at(-1)! - before).toBe(250);
	});

	it("waits the longest pause while offline, and retries at once on a wake", async () => {
		const world = new FakeWorld();
		loop(world);
		world.online = false;
		world.last.close();
		await world.advance(1000);
		expect(world.sockets).toHaveLength(1);
		world.wake();
		await settled();
		expect(world.sockets).toHaveLength(2);
	});

	it("gives up a socket not open after 20 s", async () => {
		const world = new FakeWorld();
		loop(world);
		await world.advance(CONNECT_TIMEOUT_MS - 1);
		expect(world.sockets[0]!.closed).toBe(false);
		await world.advance(1);
		expect(world.sockets[0]!.closed).toBe(true);
	});

	it("stops when canRetry says no", async () => {
		const world = new FakeWorld();
		const { states } = loop(world, async () => false);
		world.last.close();
		await world.advance(60_000);
		expect(world.sockets).toHaveLength(1);
		expect(states.at(-1)).toBe("waiting");
	});

	it("does not wait for canRetry: the next attempt goes ahead; a late no after it opened closes it, reported waiting", async () => {
		const world = new FakeWorld();
		let answer!: (retry: boolean) => void;
		const { states } = loop(
			world,
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		world.last.close();
		await world.advance(250);
		expect(world.sockets).toHaveLength(2);
		world.last.events.opened();
		expect(states.at(-1)).toBe("connected");
		answer(false);
		await world.advance(60_000);
		expect([world.sockets.length, world.last.closed, states.at(-1)]).toEqual([2, true, "waiting"]);
	});

	it("asks canRetry one question at a time: closes while it is open ask nothing more; the next close asks again", async () => {
		const world = new FakeWorld();
		const answers: ((retry: boolean) => void)[] = [];
		loop(
			world,
			() =>
				new Promise((resolve) => {
					answers.push(resolve);
				}),
		);
		for (let attempt = 0; attempt < 8; attempt++) {
			world.last.close();
			await world.advance(5000);
		}
		expect([world.sockets.length, answers.length]).toEqual([9, 1]);
		answers[0]!(true);
		await settled();
		world.last.close();
		await settled();
		expect(answers).toHaveLength(2);
	});

	it("retries at once a drop soon after a wake (the socket that was away), once per wake", async () => {
		const world = new FakeWorld();
		loop(world);
		world.last.events.opened();
		await world.advance(STABLE_MS);
		// Back from the background: the wake comes first, then the close the frozen page had not handled yet.
		world.wake();
		world.last.close();
		await world.advance(0);
		expect(world.sockets).toHaveLength(2);
		// The server is down: the next drop waits the growing pause, no tight loop.
		const closedAt = world.now;
		world.last.close();
		await world.advance(5000);
		expect(world.opens.at(-1)! - closedAt).toBe(500);
	});
});

describe("a silent socket", () => {
	it("is replaced on a wake once its next ping is overdue; one with recent frames stays", async () => {
		const world = new FakeWorld();
		loop(world);
		world.last.events.opened();
		await world.advance(10_000);
		world.last.events.received();
		world.wake();
		await world.advance(STALE_MS);
		expect(world.sockets[0]!.closed).toBe(false);
		world.wake();
		await world.advance(STALE_MS + 1000);
		expect(world.sockets[0]!.closed).toBe(true);
		// Its replacement goes at once (at the second wake's check, 1 s after it), not after a pause.
		expect(world.opens[1]).toBe(10_000 + STALE_MS + 1000);
	});

	it("closes the link at stop and opens no other", async () => {
		const world = new FakeWorld();
		const { handle } = loop(world);
		world.last.events.opened();
		handle.stop();
		expect(world.last.closed).toBe(true);
		await world.advance(60_000);
		expect(world.sockets).toHaveLength(1);
	});
});
