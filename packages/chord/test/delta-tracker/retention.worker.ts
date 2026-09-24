import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { type Tracker, track } from "../../src/delta/index.ts";

const retainedSettledObjects: object[] = [];
const retainedLargePrepared: object[] = [];
const retainedSettledChanges: object[] = [];

async function collect(ref: WeakRef<object>): Promise<void> {
	assert.ok(global.gc, "worker requires --expose-gc");
	for (let attempt = 0; attempt < 30; attempt++) {
		await setImmediate();
		global.gc();
		if (ref.deref() === undefined) return;
	}
	assert.fail("released change data is still retained");
}

function abortedPayload(tracker: Tracker<{ payload: { rows: { value: number }[] } | null }>): WeakRef<object> {
	const change = tracker.beginChange();
	change.state.payload = { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) };
	const reference = new WeakRef(change.state.payload.rows);
	change.abort();
	return reference;
}

function unadoptedPrepared(tracker: Tracker<{ payload: { rows: { value: number }[] } | null }>): WeakRef<object> {
	const change = tracker.beginChange();
	change.state.payload = { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) };
	const prepared = change.prepare();
	return new WeakRef(prepared.value.payload!.rows);
}

function draftProxies(tracker: Tracker<{ payload: { rows: { value: number }[] } | null }>): WeakRef<object> {
	const change = tracker.beginChange();
	change.state.payload = { rows: [{ value: 1 }] };
	const reference = new WeakRef(change.state.payload.rows[0]!);
	change.abort();
	return reference;
}

async function assertRetained(reference: WeakRef<object>): Promise<void> {
	assert.ok(global.gc, "worker requires --expose-gc");
	for (let attempt = 0; attempt < 5; attempt++) {
		await setImmediate();
		global.gc();
	}
	assert.notEqual(reference.deref(), undefined, "retained Prepared must retain its immutable revisions");
}

function settledLifecycle(): { tracker: WeakRef<object>; future: WeakRef<object> } {
	const tracker = track<{ payload: { rows: { value: number }[] } | null }>({ payload: null });
	const change = tracker.beginChange();
	change.state.payload = { rows: [{ value: 1 }] };
	const retainedPrepared = change.prepare();
	tracker.adopt(retainedPrepared);
	retainedSettledObjects.push(change, retainedPrepared);

	const futurePrepared = tracker.prepareReplace({
		payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) },
	});
	tracker.adopt(futurePrepared);
	return {
		tracker: new WeakRef(tracker),
		future: new WeakRef(futurePrepared.value.payload!.rows),
	};
}

const scenario = process.argv[2];
if (scenario === "settled-lifecycle") {
	const references = settledLifecycle();
	await collect(references.tracker);
	await collect(references.future);
} else if (scenario === "retained-settled-prepared") {
	const tracker = track({ payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) } });
	const retain = (): { base: WeakRef<object>; value: WeakRef<object> } => {
		const change = tracker.beginChange();
		change.state.payload.rows[0]!.value = -1;
		const prepared = change.prepare();
		const references = {
			base: new WeakRef(prepared.base.payload.rows),
			value: new WeakRef(prepared.value.payload.rows),
		};
		tracker.adopt(prepared);
		retainedLargePrepared.push(prepared);
		return references;
	};
	const references = retain();
	const replace = (): void => {
		const replacement = tracker.prepareReplace({ payload: { rows: [{ value: 1 }] } });
		tracker.adopt(replacement);
	};
	replace();
	await assertRetained(references.base);
	await assertRetained(references.value);
	retainedLargePrepared.length = 0;
	await collect(references.base);
	await collect(references.value);
} else if (scenario === "retained-settled-change") {
	const tracker = track({ payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) } });
	const settleChange = (): { base: WeakRef<object>; value: WeakRef<object> } => {
		const change = tracker.beginChange();
		change.state.payload.rows[0]!.value = -1;
		const prepared = change.prepare();
		const references = {
			base: new WeakRef(prepared.base.payload.rows),
			value: new WeakRef(prepared.value.payload.rows),
		};
		tracker.adopt(prepared);
		retainedSettledChanges.push(change);
		return references;
	};
	const references = settleChange();
	const replace = (): void => {
		const replacement = tracker.prepareReplace({ payload: { rows: [{ value: 1 }] } });
		tracker.adopt(replacement);
	};
	replace();
	await collect(references.base);
	await collect(references.value);
	assert.equal(retainedSettledChanges.length, 1);
} else if (scenario === "retained-settled-proxy") {
	const tracker = track({
		child: { value: 0 },
		payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) },
	});
	const obsolete = new WeakRef(tracker.value.payload.rows);
	const commit = (): object => {
		const change = tracker.beginChange();
		const held = change.state.child;
		held.value = 1;
		const prepared = change.prepare();
		tracker.adopt(prepared);
		return held;
	};
	retainedSettledChanges.push(commit());
	const replace = (): void => {
		const replacement = tracker.prepareReplace({ child: { value: 2 }, payload: { rows: [{ value: 1 }] } });
		tracker.adopt(replacement);
	};
	replace();
	await collect(obsolete);
	assert.throws(() => (retainedSettledChanges[0] as { value: number }).value, /settled/);
} else if (scenario === "retained-large-settled-proxy") {
	const tracker = track({ rows: Array.from({ length: 100_000 }, (_, value) => ({ value })) });
	const obsolete = new WeakRef(tracker.value.rows);
	const commit = (): object => {
		const change = tracker.beginChange();
		const held = change.state.rows[0]!;
		for (let index = 1; index < 5_000; index++) assert.equal(change.state.rows[index]!.value, index);
		held.value = -1;
		const prepared = change.prepare();
		tracker.adopt(prepared);
		return held;
	};
	retainedSettledChanges.push(commit());
	const replace = (): void => {
		const replacement = tracker.prepareReplace({ rows: [{ value: 1 }] });
		tracker.adopt(replacement);
	};
	replace();
	await collect(obsolete);
	assert.throws(() => (retainedSettledChanges[0] as { value: number }).value, /settled/);
} else if (scenario === "retained-large-placement-proxies") {
	type Root = {
		child: { value: number };
		visited: { value: number }[];
		first: number[] | null;
		second: number[] | null;
		rows: Array<number[] | null>;
	};
	const run = (kind: "write" | "writes" | "insert" | "override"): WeakRef<object> => {
		const tracker = track<Root>({
			child: { value: 0 },
			visited: Array.from({ length: 5_000 }, (_, value) => ({ value })),
			first: null,
			second: null,
			rows: kind === "override" ? [null] : [],
		});
		const change = tracker.beginChange();
		for (const value of change.state.visited) assert.equal(value.value >= 0, true);
		let held: object;
		if (kind === "write" || kind === "writes") {
			held = change.state.child;
			change.state.first = Array<number>(50_000).fill(1);
			if (kind === "writes") change.state.second = Array<number>(50_000).fill(2);
		} else {
			held = change.state.rows;
			if (kind === "insert") change.state.rows.push(Array<number>(50_000).fill(1));
			else change.state.rows[0] = Array<number>(50_000).fill(1);
		}
		const prepared = change.prepare();
		const payload = kind === "write" || kind === "writes" ? prepared.value.first : prepared.value.rows[0];
		assert.ok(payload);
		const reference = new WeakRef(payload);
		tracker.adopt(prepared);
		const replacement = tracker.prepareReplace({
			child: { value: 1 },
			visited: [],
			first: null,
			second: null,
			rows: [],
		});
		tracker.adopt(replacement);
		retainedSettledChanges.push(held);
		return reference;
	};
	const references = [run("write"), run("writes"), run("insert"), run("override")];
	for (const reference of references) await collect(reference);
	for (const held of retainedSettledChanges) assert.throws(() => Reflect.get(held, "length"), /settled/);
} else if (scenario === "stale-unprepared-change") {
	const tracker = track({ payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) } });
	const stale = tracker.beginChange();
	stale.state.payload.rows[0]!.value = -1;
	const obsolete = new WeakRef(tracker.value.payload.rows);
	const replace = (): void => {
		const winner = tracker.prepareReplace({ payload: { rows: [{ value: 1 }] } });
		tracker.adopt(winner);
	};
	replace();
	assert.throws(() => stale.prepare(), /settled/);
	retainedSettledChanges.push(stale);
	await collect(obsolete);
	assert.equal(retainedSettledChanges.length, 1);
} else if (scenario === "same-job-fast-cleanup") {
	assert.ok(global.gc, "worker requires --expose-gc");
	const tracker = track({ rows: Array.from({ length: 100_000 }, (_, value) => ({ value })) });
	global.gc();
	const readyHeap = process.memoryUsage().heapUsed;
	const commit = (value: number): void => {
		const change = tracker.beginChange();
		const draft = change.state;
		for (let index = 0; index < 4_094; index++) assert.equal(draft.rows[index]!.value, index);
		draft.rows.at(-1)!.value = value;
		const prepared = change.prepare();
		tracker.adopt(prepared);
	};
	for (let value = 0; value < 100; value++) commit(-value - 1);
	global.gc();
	const retainedMiB = (process.memoryUsage().heapUsed - readyHeap) / (1024 * 1024);
	assert.ok(retainedMiB < 16, `same-job cleanup retained ${retainedMiB.toFixed(2)} MiB`);
	assert.equal(tracker.value.rows.at(-1)!.value, -100);
} else if (scenario === "same-job-folded-ops-cleanup") {
	assert.ok(global.gc, "worker requires --expose-gc");
	const tracker = track(
		Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`field${index}`, 0])) as Record<string, number>,
	);
	global.gc();
	const readyHeap = process.memoryUsage().heapUsed;
	const commit = (value: number): void => {
		const change = tracker.beginChange();
		for (let index = 0; index < 5_000; index++) change.state[`field${index}`] = value;
		const prepared = change.prepare();
		assert.equal(prepared.ops.length, 1);
		assert.equal(prepared.ops[0]![0], "r");
		tracker.adopt(prepared);
	};
	for (let value = 1; value <= 100; value++) commit(value);
	global.gc();
	const retainedMiB = (process.memoryUsage().heapUsed - readyHeap) / (1024 * 1024);
	assert.ok(retainedMiB < 8, `same-job folded operations retained ${retainedMiB.toFixed(2)} MiB`);
	assert.equal(tracker.value.field0, 100);
} else if (scenario === "lifecycle-churn") {
	const tracker = track({ value: 0 });
	for (let index = 0; index < 100_000; index++) {
		const change = tracker.beginChange();
		change.state.value = index;
		change.abort();
	}
	const prepared = tracker.prepareReplace({ value: 1 });
	tracker.adopt(prepared);
	assert.deepEqual(tracker.value, { value: 1 });
} else if (scenario === "obsolete-revisions") {
	const tracker = track({ payload: { rows: Array.from({ length: 50_000 }, (_, value) => ({ value })) } });
	const oldRoot = new WeakRef(tracker.value.payload.rows);
	const replace = (value: number): void => {
		const prepared = tracker.prepareReplace({ payload: { rows: [{ value }] } });
		tracker.adopt(prepared);
	};
	for (let value = 0; value < 100; value++) replace(value);
	await collect(oldRoot);
	assert.deepEqual(tracker.value, { payload: { rows: [{ value: 99 }] } });
} else {
	const tracker = track<{ payload: { rows: { value: number }[] } | null }>({ payload: null });
	let reference: WeakRef<object>;
	switch (scenario) {
		case "aborted-payload":
			reference = abortedPayload(tracker);
			break;
		case "unadopted-prepared":
			reference = unadoptedPrepared(tracker);
			break;
		case "draft-proxies":
			reference = draftProxies(tracker);
			break;
		default:
			throw new Error(`unknown retention scenario: ${scenario}`);
	}
	await collect(reference);
	assert.deepEqual(tracker.value, { payload: null });
}
console.log(JSON.stringify({ scenario, passed: true }));
