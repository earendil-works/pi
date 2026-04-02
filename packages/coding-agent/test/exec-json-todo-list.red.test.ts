import { describe, expect, it } from "vitest";

import { createExecJsonEventProcessor } from "../src/exec/jsonl-event-processor.js";

describe("exec json todo list items (red)", () => {
	it("normalizes todo_write results into todo_list items", () => {
		const processor = createExecJsonEventProcessor({ threadId: "thread-todos" });

		const events = [
			...processor.consume({ type: "agent_start" }),
			...processor.consume({ type: "turn_start" }),
			...processor.consume({
				type: "tool_execution_start",
				toolCallId: "todo_1",
				toolName: "todo_write",
				args: {
					todos: [
						{ content: "Implement file change items", status: "in_progress", priority: "high" },
						{ content: "Verify failure contract", status: "pending", priority: "high" },
					],
				},
			}),
			...processor.consume({
				type: "tool_execution_end",
				toolCallId: "todo_1",
				toolName: "todo_write",
				result: {
					content: [{ type: "text", text: "[in_progress] [high] Implement file change items" }],
					details: {
						todos: [
							{ id: "todo_1", content: "Implement file change items", status: "in_progress", priority: "high" },
							{ id: "todo_2", content: "Verify failure contract", status: "pending", priority: "high" },
						],
						summary: { total: 2, pending: 1, inProgress: 1, completed: 0, blocked: 0 },
					},
				},
				isError: false,
			}),
		];

		expect(events).toContainEqual({
			type: "item.completed",
			item: {
				id: "todo_1",
				type: "todo_list",
				status: "completed",
				summary: { total: 2, pending: 1, in_progress: 1, completed: 0, blocked: 0 },
				items: [
					{ id: "todo_1", content: "Implement file change items", status: "in_progress", priority: "high" },
					{ id: "todo_2", content: "Verify failure contract", status: "pending", priority: "high" },
				],
			},
		});
	});
});
