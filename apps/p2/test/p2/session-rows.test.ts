// The server's session catalog table (plugins/sessions/catalog.ts `SessionRows`): a `branches` cell stored by version
// 1 (no branch's parent) reads at version 2 as it was; one that does not match is refused.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { SessionRows } from "../../plugins/sessions/catalog.ts";

/** The `branches` column's read of a stored cell, as the store migrates it on access. */
function readCell(value: unknown, version: number): unknown {
	const column = SessionRows.byName.get("branches");
	assert(column?.type === "json");
	return column.json.read(JSON.stringify(value), version, "branches", BACKGROUND_CONTEXT);
}

const V1_BRANCHES = [
	{ conversation: 4, label: "try OAuth" },
	{ conversation: 1, label: null },
];

describe("SessionRows branches 1 → 2", () => {
	it("reads a version 1 cell as it was", () => {
		assert.deepEqual(readCell(V1_BRANCHES, 1), V1_BRANCHES);
	});

	it("reads a version 2 cell with the conversation a branch was forked from", () => {
		const branches = [{ conversation: 4, label: "try OAuth", parent: 1 }, V1_BRANCHES[1]];
		assert.deepEqual(readCell(branches, 2), branches);
	});

	it("refuses a version 1 cell that does not match", () => {
		assert.throws(() => readCell([{ conversation: 0 }], 1), /does not match the schema/);
	});
});
