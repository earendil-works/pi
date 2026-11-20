// A conversation's run as its sidebar item shows it (plugins/sessions/sidebar/run-state.ts): busy with its work, how
// its last run ended (stopped, failed, or an ending that is no failure), and a subagent item's tooltip.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failureWords, runState, subagentTitle } from "../../plugins/sessions/sidebar/run-state.ts";
import type { Work } from "../../plugins/status/contract.ts";
import type { Child } from "../../plugins/subagents/contract.ts";

const child = (fields: Partial<Child> = {}): Child => ({
	name: "helper",
	conversationId: 2,
	model: "faux/faux-1",
	thinkingLevel: "off",
	tools: [],
	lastEntryId: 7,
	...fields,
});

const reading: Work = { since: 1_000, rounds: 3, step: { kind: "tools", names: ["read", "edit", "mcp__x__y"] } };

describe("runState", () => {
	it("is busy while its conversation works, with its work once reported, whatever the last run's ending", () => {
		assert.deepEqual(runState({ reason: "aborted" }, true, reading), { kind: "busy", work: reading });
		assert.deepEqual(runState(undefined, true, undefined), { kind: "busy" });
	});

	it("is stopped after an abort or at the tool round limit, failed with its reason and detail otherwise", () => {
		assert.deepEqual(runState({ reason: "aborted" }, false, undefined), { kind: "stopped" });
		assert.deepEqual(runState({ reason: "turn_limit", detail: "8 turns" }, false, undefined), {
			kind: "stopped",
			reason: "the tool round limit",
		});
		assert.deepEqual(runState({ reason: "model_error", detail: "overloaded" }, false, undefined), {
			kind: "failed",
			reason: "model_error",
			detail: "overloaded",
		});
		assert.deepEqual(runState({ reason: "faulted" }, false, undefined), { kind: "failed", reason: "faulted" });
	});

	it("is idle after an answer, a reset or a run with nothing to answer", () => {
		assert.deepEqual(runState(undefined, false, undefined), { kind: "idle" });
		assert.deepEqual(runState({ reason: "reset" }, false, undefined), { kind: "idle" });
		assert.deepEqual(runState({ reason: "nothing_to_answer" }, false, undefined), { kind: "idle" });
	});
});

describe("words", () => {
	it("gives a subagent's item a tooltip with its model, where it works and the tools it runs by name", () => {
		assert.equal(subagentTitle(child(), { kind: "idle" }, undefined), "faux-1 · off\nFollows the session");
		assert.equal(
			subagentTitle(child(), { kind: "busy", work: reading }, "~/wt"),
			"faux-1 · off\nWorks in ~/wt\nRunning read, edit, mcp__x__y",
		);
		assert.equal(
			subagentTitle(child(), { kind: "failed", reason: "model_error", detail: "400: bad request" }, undefined),
			"faux-1 · off\nFollows the session\nFailed: 400: bad request",
		);
		assert.equal(
			subagentTitle(child(), { kind: "failed", reason: "faulted" }, undefined),
			"faux-1 · off\nFollows the session\nFailed: Its run hit an error",
		);
		assert.equal(
			subagentTitle(child(), { kind: "stopped", reason: "the tool round limit" }, undefined),
			"faux-1 · off\nFollows the session\nStopped at the tool round limit",
		);
	});

	it("says what a failure means", () => {
		assert.equal(failureWords("model_error"), "The model's response failed");
		assert.equal(failureWords("something_new"), "Its run failed");
	});
});
