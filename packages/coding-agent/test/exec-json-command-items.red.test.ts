import { describe, expect, it } from "vitest";

import { createExecJsonEventProcessor } from "../src/exec/jsonl-event-processor.js";

describe("exec json command items (red)", () => {
	it("aggregates command output and exposes normalized exit metadata", () => {
		const processor = createExecJsonEventProcessor({ threadId: "thread-command" });

		const events = [
			...processor.consume({ type: "agent_start" }),
			...processor.consume({ type: "turn_start" }),
			...processor.consume({
				type: "tool_execution_start",
				toolCallId: "cmd_1",
				toolName: "exec_command",
				args: { cmd: "printf 'hi\\n'" },
			}),
			...processor.consume({
				type: "tool_execution_progress",
				toolCallId: "cmd_1",
				toolName: "exec_command",
				output: "hi\n",
			}),
			...processor.consume({
				type: "tool_execution_end",
				toolCallId: "cmd_1",
				toolName: "exec_command",
				result: {
					content: [{ type: "text", text: "hi\n" }],
					details: { exitCode: 0 },
				},
				isError: false,
			}),
		];

		expect(events).toContainEqual({
			type: "item.completed",
			item: {
				id: "cmd_1",
				type: "command_execution",
				command: "printf 'hi\\n'",
				status: "completed",
				output: "hi\n",
				exit_code: 0,
			},
		});
	});
});
