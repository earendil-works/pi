// A subagent's state and its words in the sidebar (plugins/sessions/sidebar/subagent-state.ts): busy with its step,
// how its last run ended (stopped, failed, or an ending that is no failure), idle since its newest message, and the
// words of a step at the row's end.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolActivity } from "@p2/app/v1/web";
import {
	failureWords,
	stepWords,
	subagentState,
	subagentTitle,
} from "../../plugins/sessions/sidebar/subagent-state.ts";
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

const TOOLS: ReadonlyMap<string, ToolActivity> = new Map([
	["read", { brief: "Reading" }],
	["edit", { brief: "Editing" }],
]);

const reading: Work = { since: 1_000, rounds: 3, step: { kind: "tools", names: ["read", "edit", "mcp__x__y"] } };

describe("subagentState", () => {
	it("is busy while its conversation works, with its work once reported", () => {
		assert.deepEqual(subagentState(child({ failure: { reason: "aborted" } }), true, reading), {
			kind: "busy",
			work: reading,
		});
		assert.deepEqual(subagentState(child(), true, undefined), { kind: "busy" });
	});

	it("is stopped after an abort or at the tool round limit, failed with its reason and detail otherwise", () => {
		assert.deepEqual(subagentState(child({ failure: { reason: "aborted" } }), false, undefined), { kind: "stopped" });
		assert.deepEqual(
			subagentState(child({ failure: { reason: "turn_limit", detail: "8 turns" } }), false, undefined),
			{
				kind: "stopped",
				reason: "the tool round limit",
			},
		);
		assert.deepEqual(
			subagentState(child({ failure: { reason: "model_error", detail: "overloaded" } }), false, undefined),
			{ kind: "failed", reason: "model_error", detail: "overloaded" },
		);
		assert.deepEqual(subagentState(child({ failure: { reason: "faulted" } }), false, undefined), {
			kind: "failed",
			reason: "faulted",
		});
	});

	it("is idle since its newest message after an answer, a reset or a run with nothing to answer", () => {
		assert.deepEqual(subagentState(child({ updatedAt: 5 }), false, undefined), { kind: "idle", since: 5 });
		assert.deepEqual(subagentState(child({ failure: { reason: "reset" }, updatedAt: 5 }), false, undefined), {
			kind: "idle",
			since: 5,
		});
		assert.deepEqual(subagentState(child({ failure: { reason: "nothing_to_answer" } }), false, undefined), {
			kind: "idle",
		});
	});
});

describe("words", () => {
	it("names the first running tool by its brief at the row's end, and how many more run", () => {
		assert.equal(stepWords(reading, TOOLS), "Reading +2");
		assert.equal(stepWords({ ...reading, step: { kind: "tools", names: ["mcp__x__y"] } }, TOOLS), "Using a tool");
		assert.equal(stepWords({ ...reading, step: { kind: "thinking" } }, TOOLS), "Thinking");
		assert.equal(stepWords({ ...reading, step: { kind: "compacting" } }, TOOLS), "Compacting");
		assert.equal(stepWords({ ...reading, step: { kind: "working" } }, TOOLS), "Working");
		assert.equal(stepWords(undefined, TOOLS), "Working");
	});

	it("gives its row a tooltip with its model, where it works and the tools it runs by name", () => {
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
