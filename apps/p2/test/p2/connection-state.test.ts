// The page's link as its UI shows it (src/runtime/connection-state.ts): "Offline" only after the link stayed closed 2 s,
// the wait cancelled by a reconnect, armed once per close (a failed retry's repeated report neither restarts it nor
// re-renders), a device known offline shown at once while closed, a link open on such a device not offline.
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { ConnectionStore, OFFLINE_AFTER_MS, showsOffline } from "../../src/runtime/connection-state.ts";

/** A store with fake timers, and how many times its listeners heard a change. */
function store() {
	mock.timers.enable({ apis: ["setTimeout"] });
	const connection = new ConnectionStore();
	const heard = { count: 0 };
	connection.subscribe(() => heard.count++);
	return { connection, heard };
}

describe("the page's link as shown", () => {
	it("says offline only once the link stayed closed 2 s", (t) => {
		t.after(() => mock.timers.reset());
		const { connection } = store();
		connection.set(true);
		connection.set(false);
		mock.timers.tick(OFFLINE_AFTER_MS - 1);
		assert.equal(showsOffline(connection.state, true), false);
		mock.timers.tick(1);
		assert.equal(showsOffline(connection.state, true), true);
		connection.set(true);
		assert.equal(showsOffline(connection.state, true), false);
	});

	it("says nothing when the link comes back within 2 s: the wait is cancelled", (t) => {
		t.after(() => mock.timers.reset());
		const { connection, heard } = store();
		connection.set(true);
		connection.set(false);
		mock.timers.tick(OFFLINE_AFTER_MS / 2);
		connection.set(true);
		mock.timers.tick(OFFLINE_AFTER_MS * 2);
		assert.deepEqual([connection.state, heard.count], [{ connected: true, down: false }, 3]); // open, closed, open: never down
	});

	it("arms the wait once per close: repeated closed reports neither restart it nor republish", (t) => {
		t.after(() => mock.timers.reset());
		const { connection, heard } = store();
		connection.set(true);
		connection.set(false);
		mock.timers.tick(OFFLINE_AFTER_MS / 2);
		connection.set(false);
		mock.timers.tick(OFFLINE_AFTER_MS / 2);
		assert.equal(connection.state.down, true, "the wait counts from the first close");
		const before = heard.count;
		for (let retry = 0; retry < 5; retry++) connection.set(false);
		mock.timers.tick(OFFLINE_AFTER_MS * 2);
		assert.equal(heard.count, before);
	});

	it("starts the wait at the first closed report of the page (it starts closed)", (t) => {
		t.after(() => mock.timers.reset());
		const { connection } = store();
		connection.set(false);
		mock.timers.tick(OFFLINE_AFTER_MS);
		assert.equal(showsOffline(connection.state, true), true);
	});

	it("says offline at once while closed on a device known offline; never while open", () => {
		assert.equal(showsOffline({ connected: false, down: false }, false), true);
		assert.equal(showsOffline({ connected: true, down: false }, false), false, "the server on the same phone");
		assert.equal(showsOffline({ connected: false, down: false }, true), false);
	});
});
