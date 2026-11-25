// What the status worker reports a busy conversation doing (plugins/status/worker.ts `stepOf`): its tool round's calls
// not done yet first, then a compaction, the model's answer, other work.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveState } from "@earendil-works/pi-durable";
import { stepOf } from "../../plugins/status/worker.ts";

type Slot = NonNullable<LiveState["tools"]>[number];
const slot = (name: string, status: Slot["status"]): Slot => ({ callId: name, name, status });

describe("stepOf", () => {
	it("names the tool calls of the round not done yet, in call order, before anything else", () => {
		const live: LiveState = {
			tools: [slot("read", "done"), slot("bash", "running"), slot("edit", "pending"), slot("sleep", "sleeping")],
		};
		assert.deepEqual(stepOf(live, new Set(["pi.generation", "pi.compaction"])), {
			kind: "tools",
			names: ["bash", "edit", "sleep"],
		});
	});

	it("is compacting with a compaction task once every call is done", () => {
		const live: LiveState = { tools: [slot("read", "done")] };
		assert.deepEqual(stepOf(live, new Set(["pi.generation", "pi.compaction"])), { kind: "compacting" });
	});

	it("is thinking with a generation task and no compaction", () => {
		assert.deepEqual(stepOf({}, new Set(["pi.generation"])), { kind: "thinking" });
	});

	it("is working with other tasks only, or without a live document", () => {
		assert.deepEqual(stepOf({}, new Set(["p2.hook"])), { kind: "working" });
		assert.deepEqual(stepOf(undefined, new Set()), { kind: "working" });
	});
});
