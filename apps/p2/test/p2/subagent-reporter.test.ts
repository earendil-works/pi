import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationHandle, SettledSubmissionRecord, Submission } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@p2/app/v1";
import { settledOrWithdrawn } from "../../plugins/subagents/tools.ts";

type Status = "queued" | "placed";

/** A submission and its subagent conversation, driven by the test. */
function fixture(initial: Status, idle: boolean) {
	let status: Status = initial;
	let settle: (record: SettledSubmissionRecord) => void = () => {};
	const settled = new Promise<SettledSubmissionRecord>((resolve) => {
		settle = resolve;
	});
	let becomeIdle: () => void = () => {};
	let idleNow = idle;
	const aborts: string[] = [];
	const submission = {
		id: 7,
		wait: () => settled,
		status: async () => ({ status }),
		abort: async () => {
			if (status !== "queued") return "already_placed";
			aborts.push("aborted");
			return "aborted";
		},
	} as unknown as Submission;
	const subagent = {
		id: 3,
		waitForIdle: () =>
			idleNow
				? Promise.resolve()
				: new Promise<void>((resolve) => {
						becomeIdle = () => {
							idleNow = true;
							resolve();
						};
					}),
	} as unknown as ConversationHandle;
	return {
		submission,
		subagent,
		aborts,
		setStatus: (next: Status) => {
			status = next;
		},
		settle: (record: SettledSubmissionRecord) => settle(record),
		idle: () => becomeIdle(),
	};
}

const context: Context = BACKGROUND_CONTEXT;
const answered = { status: "answered" } as unknown as SettledSubmissionRecord;

test("subagent reporter: an answer settles the wait", async () => {
	const f = fixture("placed", false);
	const result = settledOrWithdrawn(f.submission, f.subagent, async () => {}, context);
	f.settle(answered);
	assert.equal(await result, answered);
	assert.deepEqual(f.aborts, []);
});

test("subagent reporter: a message still queued once the subagent is idle is withdrawn, not awaited forever", async () => {
	// The subagent's run failed with this message queued behind it: Durable leaves it queued and nothing places it.
	const f = fixture("queued", false);
	const result = settledOrWithdrawn(f.submission, f.subagent, async () => {}, context);
	f.idle();
	assert.equal(await result, undefined);
	assert.deepEqual(f.aborts, ["aborted"]);
});

test("subagent reporter: a message placed meanwhile is awaited, not withdrawn", async () => {
	const f = fixture("queued", true);
	// The pause lets an admission in flight place the message.
	const result = settledOrWithdrawn(
		f.submission,
		f.subagent,
		async () => {
			f.setStatus("placed");
		},
		context,
	);
	setTimeout(() => f.settle(answered), 10);
	assert.equal(await result, answered);
	assert.deepEqual(f.aborts, []);
});
