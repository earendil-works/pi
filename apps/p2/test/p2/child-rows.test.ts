// The server's table of each session's subagents (plugins/subagents/children.ts `ChildRows`): a cell stored by
// version 1 (no time or failure) reads at version 2 as it was; one that does not match is refused.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ChildRows } from "../../plugins/subagents/children.ts";

/** The `children` column's read of a stored cell, as the store migrates it on access. */
function readCell(value: unknown, version: number): unknown {
	const column = ChildRows.byName.get("children");
	assert(column?.type === "json");
	return column.json.read(JSON.stringify(value), version, "children", BACKGROUND_CONTEXT);
}

const V1_CHILDREN = [
	{
		name: "helper",
		archived: true,
		conversationId: 2,
		model: "faux/faux-1",
		thinkingLevel: "off",
		tools: ["read"],
		location: { cwd: "/w/sub", env: null },
		lastEntryId: 9,
	},
	{
		name: "agent",
		kind: "agent",
		callId: "c1/c1",
		conversationId: 3,
		model: "faux/faux-1",
		thinkingLevel: "off",
		tools: [],
		lastEntryId: 0,
	},
];

describe("ChildRows children 1 → 2", () => {
	it("reads a version 1 cell as it was", () => {
		assert.deepEqual(readCell(V1_CHILDREN, 1), V1_CHILDREN);
	});

	it("reads a version 2 cell with its time and failure", () => {
		const children = [
			{
				...V1_CHILDREN[0],
				updatedAt: 5,
				failure: { reason: "model_error", detail: "overloaded" },
			},
		];
		assert.deepEqual(readCell(children, 2), children);
	});

	it("refuses a version 1 cell that does not match", () => {
		assert.throws(() => readCell([{ name: "helper" }], 1), /does not match the schema/);
	});
});
