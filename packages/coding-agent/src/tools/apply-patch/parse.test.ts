import { describe, expect, it } from "vitest";
import { parseApplyPatchInput } from "./parse.js";

describe("parseApplyPatchInput", () => {
	it("extracts add/update/delete/move operations", () => {
		const input = [
			"*** Begin Patch",
			"*** Add File: added.txt",
			"+hello",
			"*** Update File: old.txt",
			"*** Move to: moved/new.txt",
			"@@",
			"-old",
			"+new",
			"*** Delete File: remove.txt",
			"*** End Patch",
		].join("\n");

		const result = parseApplyPatchInput(input);

		expect(result.ops).toEqual([
			{ type: "add", path: "added.txt" },
			{ type: "update", path: "old.txt", movedTo: "moved/new.txt" },
			{ type: "delete", path: "remove.txt" },
		]);
		expect(result.deletedPaths).toEqual(["remove.txt"]);
	});

	it("deduplicates deleted paths", () => {
		const input = [
			"*** Begin Patch",
			"*** Delete File: remove.txt",
			"*** Delete File: remove.txt",
			"*** End Patch",
		].join("\n");

		const result = parseApplyPatchInput(input);

		expect(result.deletedPaths).toEqual(["remove.txt"]);
	});
});
