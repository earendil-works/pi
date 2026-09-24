import assert from "node:assert/strict";
import { applyImmutable } from "@earendil-works/chord/delta";
import { test } from "vitest";
import { track } from "../../../src/harness/pico3/legacy-tracker.ts";

test("preserves draft-sourced descendant edits without exposing tracker metadata", () => {
	const tracker = track({
		a: { child: { value: 1 } },
		b: null as { child: { value: number } } | null,
		rows: [{ child: { value: 1 } }, { child: { value: 2 } }],
	});
	let replica = applyImmutable<typeof tracker.target>(undefined, tracker.flush());

	tracker.state.a.child.value = 2;
	tracker.state.b = tracker.state.a;
	tracker.state.rows[1] = tracker.state.rows[0]!;
	tracker.state.rows[1]!.child.value = 3;
	const operations = tracker.flush();
	replica = applyImmutable(replica, operations);

	assert.deepEqual(tracker.target, {
		a: { child: { value: 2 } },
		b: { child: { value: 2 } },
		rows: [{ child: { value: 1 } }, { child: { value: 3 } }],
	});
	assert.deepEqual(replica, tracker.target);
	assert.notEqual(tracker.target.a, tracker.target.b);
	assert.notEqual(tracker.target.a.child, tracker.target.b?.child);
	assert.notEqual(tracker.target.rows[0], tracker.target.rows[1]);
	assert.notEqual(tracker.target.rows[0]!.child, tracker.target.rows[1]!.child);
});
