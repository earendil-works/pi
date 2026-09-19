// Isolated --expose-gc scenarios; invoked by delta-retention.test.ts.
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { apply, type Tracker, track } from "../src/delta/index.ts";

async function collect(): Promise<void> {
	assert.ok(global.gc, "worker requires --expose-gc");
	// WeakRef keeps dereferenced/created targets alive through the current job.
	await setImmediate();
	global.gc();
	await setImmediate();
	global.gc();
	await setImmediate();
}
async function waitForCollection(ref: WeakRef<object>): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		await collect();
		if (ref.deref() === undefined) return;
	}
	assert.fail("an otherwise unreferenced child proxy is still retained");
}
function sampleChild(t: Tracker<{ rows: { n: number }[] }>): WeakRef<object> {
	return new WeakRef(t.state.rows[0]);
}
function fillCaches(state: { n: number }[]): WeakRef<object> {
	let sum = 0;
	for (let i = 0; i < state.length; i++) sum += state[i].n;
	assert.ok(sum >= 0);
	return new WeakRef(state[0]);
}
function select(t: Tracker<{ rows: { text: string }[]; selected: { text: string } | null }>): WeakRef<object> {
	const child = t.state.rows[0];
	t.state.selected = child;
	return new WeakRef(child);
}

// Separate frames prevent VM temporaries from pinning the objects under test.
function disposableTracker(): [WeakRef<object>, WeakRef<object>] {
	const t = track({ rows: [{ n: 1 }] });
	t.flush();
	void t.state.rows[0].n;
	return [new WeakRef(t.state), new WeakRef(t.target)];
}
function blockedView(t: Tracker<{ holder: { constructor: { n: number } }; safe: { n: number } }>): WeakRef<object> {
	const view = t.state.holder.constructor;
	assert.equal(view.n, 1);
	return new WeakRef(view);
}

const scenario = process.argv[2];
switch (scenario) {
	case "tracker-disposal": {
		const [proxy, raw] = disposableTracker();
		await waitForCollection(proxy);
		await waitForCollection(raw);
		break;
	}
	case "raw-root-rebase": {
		const t = track([1]);
		let replica = apply<number[]>(undefined, t.flush());
		t.state = t.target;
		replica = apply(replica, t.flush());
		t.state.push(2);
		replica = apply(replica, t.flush());
		assert.deepEqual(replica, t.target);
		break;
	}
	case "array-subtree-reattach": {
		const t = track({ rows: [[{ nested: { n: 1 } }, { nested: { n: 2 } }], []] });
		let replica = apply<typeof t.state>(undefined, t.flush());
		const held = t.state.rows[0];
		const leaf = held[0].nested;
		held.reverse(); // clears the array's index cache, but not held descendants
		replica = apply(replica, t.flush());
		t.state.rows.shift();
		replica = apply(replica, t.flush());
		await collect();
		t.state.rows.push(held);
		replica = apply(replica, t.flush());
		await collect();
		leaf.n = 42;
		replica = apply(replica, t.flush());
		assert.deepEqual(replica, t.target);
		break;
	}
	case "unheld": {
		const t = track({ rows: [{ n: 1 }] });
		t.flush();
		const ref = sampleChild(t);
		await waitForCollection(ref);
		assert.equal(t.target.rows[0].n, 1);
		let replica = apply<typeof t.state>(undefined, [["r", structuredClone(t.target)]]);
		t.state.rows[0].n = 2;
		replica = apply(replica, t.flush());
		assert.deepEqual(replica, t.target);
		break;
	}
	case "held-descendant": {
		const t = track({
			rows: [
				{ nested: { text: "a" }, values: [1] },
				{ nested: { text: "b" }, values: [2] },
			],
		});
		let replica = apply<typeof t.state>(undefined, t.flush());
		const held = t.state.rows[1].nested;
		const values = t.state.rows[1].values;
		for (let i = 0; i < 8; i++) {
			await collect();
			t.state.rows.unshift({ nested: { text: `head-${i}` }, values: [] });
			replica = apply(replica, t.flush());
			await collect();
			held.text += "x";
			values.push(i);
			assert.equal(t.state.rows[i + 2].nested, held);
			assert.equal(t.state.rows[i + 2].values, values);
			replica = apply(replica, t.flush());
			assert.deepEqual(replica, t.target);
		}
		t.state.rows.reverse();
		replica = apply(replica, t.flush());
		await collect();
		held.text += "reversed";
		values.push(99);
		replica = apply(replica, t.flush());
		assert.deepEqual(replica, t.target);
		break;
	}
	case "held-array-reacquire": {
		const t = track({ rows: [[1], [2]] });
		let replica = apply<typeof t.state>(undefined, t.flush());
		const held = t.state.rows[1];
		for (let i = 0; i < 5; i++) {
			t.state.rows.unshift([]);
			assert.equal(t.state.rows[i + 2], held);
			held.push(10 + i);
			replica = apply(replica, t.flush());
			assert.deepEqual(replica, t.target);
			await collect();
		}
		break;
	}
	case "held-identity": {
		const t = track({ rows: [{ n: 1 }, { n: 2 }] });
		let replica = apply<typeof t.state>(undefined, t.flush());
		const held = t.state.rows[1];
		for (let i = 0; i < 10; i++) {
			await collect();
			assert.equal(t.state.rows[1], held);
			held.n++;
			replica = apply(replica, t.flush());
			assert.deepEqual(replica, t.target);
		}
		break;
	}
	case "alias-rewrap": {
		const t = track<{ rows: { text: string }[]; selected: { text: string } | null }>({
			rows: [{ text: "a" }],
			selected: null,
		});
		let replica = apply<typeof t.state>(undefined, t.flush());
		const ref = select(t);
		replica = apply(replica, t.flush());
		await waitForCollection(ref);
		for (let i = 0; i < 5; i++) {
			t.state.selected!.text += "x";
			replica = apply(replica, t.flush());
			assert.deepEqual(replica, JSON.parse(JSON.stringify(t.target)));
			assert.equal(t.state.selected, t.state.rows[0]);
			await collect();
		}
		break;
	}
	case "detach-reinsert": {
		const t = track({ rows: [{ nested: { n: 1 } }, { nested: { n: 2 } }] });
		let replica = apply<typeof t.state>(undefined, t.flush());
		const held = t.state.rows[1];
		t.state.rows.pop();
		replica = apply(replica, t.flush());
		await collect();
		held.nested.n = 9;
		assert.deepEqual(t.flush(), []);
		t.state.rows.unshift(held);
		replica = apply(replica, t.flush());
		await collect();
		held.nested.n = 10;
		replica = apply(replica, t.flush());
		assert.deepEqual(replica, JSON.parse(JSON.stringify(t.target)));
		break;
	}
	case "root-array-windows": {
		const t = track(Array.from({ length: 10_000 }, (_, n) => ({ n })));
		t.flush();
		await collect();
		const start = process.memoryUsage().heapUsed;
		for (let round = 0; round < 12; round++) {
			const ref = fillCaches(t.state);
			await waitForCollection(ref);
		}
		for (let i = 0; i < 4; i++) await collect();
		const added = process.memoryUsage().heapUsed - start;
		// Generous bound for engine/version variance, not a throughput assertion.
		assert.ok(added < 12 * 1024 * 1024, `read/GC windows retained ${added} bytes of bookkeeping`);
		assert.equal(t.state[9999].n, 9999);
		console.log(JSON.stringify({ retainedBookkeepingBytes: added }));
		break;
	}
	case "blocked-view": {
		const t = track({ holder: { constructor: { n: 1 } }, safe: { n: 0 } });
		t.flush();
		const blocked = blockedView(t);
		await waitForCollection(blocked);
		assert.throws(() => {
			t.state.holder.constructor.n = 2;
		});
		assert.equal(t.state.holder.constructor.n, 1);
		assert.deepEqual(t.flush(), []);
		break;
	}
	default:
		throw new Error(`unknown retention scenario: ${scenario}`);
}
console.log(JSON.stringify({ scenario, passed: true }));
