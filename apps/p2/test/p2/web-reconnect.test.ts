// The browser's connection loop (src/web/reconnect.ts) with a manual clock and fake sockets.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONNECT_TIMEOUT_MS,
	keepConnected,
	RETRY_INITIAL_MS,
	RETRY_MAX_MS,
	type ReconnectEnvironment,
	type ReconnectLink,
	type SocketEvents,
	STABLE_MS,
	STALE_MS,
	WAKE_GRACE_MS,
} from "../../src/web/reconnect.ts";

type FakeSocket = { events: SocketEvents; link: ReconnectLink & { closedWith: string | undefined } };

function setup(options: { canRetry?: () => Promise<boolean>; silenceTimeoutMs?: number } = {}) {
	let now = 0;
	let timers: { at: number; callback: () => void }[] = [];
	let wake: (() => void) | undefined;
	let online = true;
	const sockets: FakeSocket[] = [];
	const connected: boolean[] = [];
	const logs: string[] = [];
	const environment: ReconnectEnvironment = {
		now: () => now,
		after: (ms, callback) => {
			const timer = { at: now + ms, callback };
			timers.push(timer);
			return () => {
				timers = timers.filter((entry) => entry !== timer);
			};
		},
		online: () => online,
		onWake: (listener) => {
			wake = listener;
			return () => {
				wake = undefined;
			};
		},
		log: (message) => logs.push(message),
	};
	const connection = keepConnected({
		open: (events) => {
			const handlers: ((reason: string) => void)[] = [];
			const link = {
				closedWith: undefined as string | undefined,
				onClose: (handler: (reason: string) => void) => handlers.push(handler),
				close: (reason = "closed") => {
					if (link.closedWith !== undefined) return;
					link.closedWith = reason;
					for (const handler of handlers) handler(reason);
				},
			};
			sockets.push({ events, link });
			return link;
		},
		onConnected: (value) => connected.push(value),
		canRetry: options.canRetry ?? (() => Promise.resolve(true)),
		...(options.silenceTimeoutMs === undefined ? {} : { silenceTimeoutMs: options.silenceTimeoutMs }),
		environment,
	});
	/** Advances the clock to `ms` later, running due timers and letting promise callbacks settle in between. */
	const advance = async (ms: number) => {
		const end = now + ms;
		for (;;) {
			await new Promise((resolve) => setImmediate(resolve));
			const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers = timers.filter((timer) => timer !== due);
			now = Math.max(now, due.at);
			due.callback();
		}
		now = end;
		await new Promise((resolve) => setImmediate(resolve));
	};
	/** Ends the newest socket as a closed socket would. */
	const drop = (reason = "socket closed") => sockets.at(-1)?.link.close(reason);
	return {
		sockets,
		connected,
		logs,
		advance,
		drop,
		wake: () => wake?.(),
		/** A frozen page: time passes, no timer runs until the next `advance`. */
		freeze: (ms: number) => {
			now += ms;
		},
		stop: () => connection.stop(),
		setOnline: (value: boolean) => {
			online = value;
		},
	};
}

describe("web reconnect", () => {
	it("backs off while connections fail and starts over after one that worked", async () => {
		const t = setup();
		assert.equal(t.sockets.length, 1);
		// Never opened: 250, 500, 1000 ms.
		for (const delay of [RETRY_INITIAL_MS, RETRY_INITIAL_MS * 2, RETRY_INITIAL_MS * 4]) {
			const count: number = t.sockets.length;
			t.drop();
			await t.advance(delay - 1);
			assert.equal(t.sockets.length, count);
			await t.advance(1);
			assert.equal(t.sockets.length, count + 1);
		}
		// This one works for a while, then drops: the next retry is quick again.
		t.sockets.at(-1)?.events.opened();
		await t.advance(STABLE_MS);
		t.drop();
		await t.advance(RETRY_INITIAL_MS);
		assert.equal(t.sockets.length, 5);
		assert.deepEqual(t.connected, [false, false, false, true, false]);
	});

	it("keeps backing off when connections open and end at once", async () => {
		const t = setup();
		for (let index = 0; index < 6; index += 1) {
			t.sockets.at(-1)?.events.opened();
			t.drop("protocol-version 99");
			await t.advance(RETRY_MAX_MS);
		}
		const count: number = t.sockets.length;
		t.sockets.at(-1)?.events.opened();
		t.drop();
		await t.advance(RETRY_MAX_MS - 1);
		assert.equal(t.sockets.length, count);
		await t.advance(1);
		assert.equal(t.sockets.length, count + 1);
	});

	it("gives up an attempt that does not open", async () => {
		const t = setup();
		await t.advance(CONNECT_TIMEOUT_MS);
		assert.match(t.sockets[0]?.link.closedWith ?? "", /not open after 20.0 s/);
		await t.advance(RETRY_INITIAL_MS);
		assert.equal(t.sockets.length, 2);
		// An attempt that opened in time is not affected by the timeout.
		t.sockets[1]?.events.opened();
		await t.advance(CONNECT_TIMEOUT_MS);
		assert.equal(t.sockets[1]?.link.closedWith, undefined);
	});

	it("retries at once on wake instead of waiting out the backoff", async () => {
		const t = setup();
		for (let index = 0; index < 5; index += 1) {
			t.drop();
			await t.advance(RETRY_MAX_MS);
		}
		const count: number = t.sockets.length;
		t.drop();
		await t.advance(10);
		t.wake();
		assert.equal(t.sockets.length, count + 1);
	});

	it("retries at once when woken while deciding whether to retry", async () => {
		let release: ((value: boolean) => void) | undefined;
		const t = setup({
			canRetry: () =>
				new Promise((resolve) => {
					release = resolve;
				}),
		});
		for (let index = 0; index < 4; index += 1) {
			t.drop();
			release?.(true);
			await t.advance(RETRY_MAX_MS);
		}
		const count: number = t.sockets.length;
		t.drop();
		t.wake();
		release?.(true);
		await t.advance(0);
		assert.equal(t.sockets.length, count + 1);
	});

	it("replaces an open socket that stayed silent while the page was away", async () => {
		const t = setup();
		const socket = t.sockets[0];
		socket?.events.opened();
		await t.advance(STALE_MS + 5000);
		t.wake();
		// Messages held while frozen get a moment to arrive first.
		await t.advance(WAKE_GRACE_MS - 1);
		assert.equal(socket?.link.closedWith, undefined);
		await t.advance(1);
		assert.match(socket?.link.closedWith ?? "", /no message from the server for 31.0 s/);
		await t.advance(RETRY_INITIAL_MS);
		assert.equal(t.sockets.length, 2);
	});

	it("keeps a socket that hears from the server after a wake", async () => {
		const t = setup();
		const socket = t.sockets[0];
		socket?.events.opened();
		await t.advance(STALE_MS + 5000);
		t.wake();
		socket?.events.received();
		await t.advance(WAKE_GRACE_MS);
		assert.equal(socket?.link.closedWith, undefined);
	});

	it("after a network change, replaces the socket once the server's ping is overdue", async () => {
		const t = setup();
		const socket = t.sockets[0];
		socket?.events.opened();
		await t.advance(5000);
		socket?.events.received();
		t.wake();
		await t.advance(STALE_MS);
		assert.equal(socket?.link.closedWith, undefined);
		await t.advance(1);
		assert.match(socket?.link.closedWith ?? "", /no message from the server/);
	});

	it("does not replace a socket that keeps receiving after a network change", async () => {
		const t = setup();
		const socket = t.sockets[0];
		socket?.events.opened();
		t.wake();
		for (let index = 0; index < 4; index += 1) {
			await t.advance(15_000);
			socket?.events.received();
		}
		assert.equal(socket?.link.closedWith, undefined);
	});

	it("stops when told not to retry", async () => {
		const t = setup({ canRetry: () => Promise.resolve(false) });
		t.drop();
		await t.advance(RETRY_MAX_MS * 2);
		t.wake();
		assert.equal(t.sockets.length, 1);
	});

	it("waits for the longest delay while offline, and goes at once when back online", async () => {
		const t = setup();
		t.setOnline(false);
		t.drop();
		await t.advance(RETRY_MAX_MS - 1);
		assert.equal(t.sockets.length, 1);
		t.setOnline(true);
		t.wake();
		assert.equal(t.sockets.length, 2);
	});

	it("logs close codes and how long the connection was open", async () => {
		const t = setup();
		t.sockets[0]?.events.closed(1006, "", false);
		t.drop();
		await t.advance(RETRY_INITIAL_MS);
		t.sockets[1]?.events.opened();
		await t.advance(12_000);
		t.drop("ping timeout");
		t.sockets[1]?.events.closed(1000, "", true);
		assert.deepEqual(t.logs, [
			"Socket closed before opening: code 1006, not clean",
			"Connection failed after 0.0 s: socket closed",
			"Connection lost after 12.0 s open: ping timeout",
			"Socket closed after opening: code 1000",
		]);
	});

	it("with a silence timeout, replaces an open socket that stops hearing from the server", async () => {
		const t = setup({ silenceTimeoutMs: 45_000 });
		const socket = t.sockets[0];
		socket?.events.opened();
		for (let index = 0; index < 6; index += 1) {
			await t.advance(15_000);
			socket?.events.received();
		}
		assert.equal(socket?.link.closedWith, undefined);
		await t.advance(45_000);
		assert.equal(socket?.link.closedWith, undefined);
		await t.advance(1);
		assert.match(socket?.link.closedWith ?? "", /no message from the server for 45.0 s/);
		await t.advance(RETRY_INITIAL_MS);
		assert.equal(t.sockets.length, 2);
	});

	it("gives a frozen page's held messages a moment before the silence timeout replaces the socket", async () => {
		const t = setup({ silenceTimeoutMs: 45_000 });
		const kept = t.sockets[0];
		kept?.events.opened();
		t.freeze(120_000);
		await t.advance(0);
		assert.equal(kept?.link.closedWith, undefined);
		kept?.events.received();
		await t.advance(WAKE_GRACE_MS);
		assert.equal(kept?.link.closedWith, undefined);
		// Still watched: silence after that replaces it.
		await t.advance(45_001);
		assert.match(kept?.link.closedWith ?? "", /no message from the server/);

		await t.advance(RETRY_INITIAL_MS);
		const dead = t.sockets[1];
		dead?.events.opened();
		t.freeze(120_000);
		await t.advance(WAKE_GRACE_MS);
		assert.match(dead?.link.closedWith ?? "", /no message from the server for 121.0 s/);
	});

	it("stops: closes the socket, retries nothing and ignores wakes", async () => {
		const t = setup();
		t.sockets[0]?.events.opened();
		t.stop();
		assert.equal(t.sockets[0]?.link.closedWith, "stopped");
		t.wake();
		await t.advance(RETRY_MAX_MS * 2);
		assert.equal(t.sockets.length, 1);
		assert.deepEqual(t.connected, [true]);
	});
});
