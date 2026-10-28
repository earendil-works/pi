import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.ts";

describe("compaction file operations", () => {
	it("include files touched by nested calls recorded on tool results", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "codemode-1",
			toolName: "codemode",
			content: [],
			isError: false,
			timestamp: 0,
			nestedCalls: {
				calls: [
					{ id: "codemode-1/1", name: "read", arguments: { path: "a.ts" }, status: "ok" },
					{ id: "codemode-1/2", name: "edit", arguments: { path: "b.ts", edits: [] }, status: "ok" },
					{ id: "codemode-1/3", name: "write", argumentsBytes: 40000, status: "ok" },
				],
				complete: false,
			},
		};
		const fileOps = createFileOps();
		extractFileOpsFromMessage(result, fileOps);
		expect(computeFileLists(fileOps)).toEqual({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
	});
});
