import { describe, expect, it } from "vitest";

import { createExecJsonEventProcessor } from "../src/exec/jsonl-event-processor.js";

describe("exec json file change items (red)", () => {
	it("normalizes apply_patch results into file_change items", () => {
		const processor = createExecJsonEventProcessor({ threadId: "thread-file-change" });

		const events = [
			...processor.consume({ type: "agent_start" }),
			...processor.consume({ type: "turn_start" }),
			...processor.consume({
				type: "tool_execution_start",
				toolCallId: "patch_1",
				toolName: "apply_patch",
				args: { input: "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch\n" },
			}),
			...processor.consume({
				type: "tool_execution_end",
				toolCallId: "patch_1",
				toolName: "apply_patch",
				result: {
					content: [{ type: "text", text: "Done!" }],
					details: {
						parsed: {
							opCount: 1,
							ops: [{ type: "add", path: "note.txt" }],
						},
					},
				},
				isError: false,
			}),
		];

		expect(events).toContainEqual({
			type: "item.completed",
			item: {
				id: "patch_1",
				type: "file_change",
				paths: ["note.txt"],
				change_kind: "apply_patch",
				status: "completed",
			},
		});
	});
});
